import { makeFunctionReference } from "convex/server";
import { execFileAsync } from "./proc.js";
import { getSubtreePids, indexProcessChildren } from "./resourceMonitor.js";
import type { SyncService } from "./syncService.js";
import type { HibernationCandidate } from "./hibernation.js";

export const enabled = () => process.env.CODECAST_MEMORY_PARKING_V1 === "1";

const canParkSession = makeFunctionReference<
  "query",
  { bearer: string; conversation_id: string; session_id: string },
  boolean
>("edgeLink:canParkSession");

export type ParkingMemory = {
  budgetBytes: number;
  usedBytes: number;
  rssBySession: ReadonlyMap<string, number>;
};

export function underPressure(
  memory: ParkingMemory | undefined,
): memory is ParkingMemory {
  return !!memory && memory.usedBytes >= memory.budgetBytes * 0.9;
}

const validPid = (pid: number) => Number.isSafeInteger(pid) && pid > 1;
let failures = 0;

async function readParkingRss() {
  const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid=,rss="], {
    timeout: 10_000,
    killSignal: "SIGKILL",
    maxBuffer: 2 * 1024 * 1024,
  });
  return stdout;
}

export async function sampleParkingMemory(
  budgetBytes: number,
  sessions: ReadonlyMap<string, { pid: number }>,
  report: (message: string) => void = () => {},
  read = readParkingRss,
): Promise<ParkingMemory | undefined> {
  const roots = new Map<number, string | null>();
  for (const [sessionId, { pid }] of sessions)
    if (validPid(pid)) roots.set(pid, roots.has(pid) ? null : sessionId);
  if (roots.size === 0)
    return { budgetBytes, usedBytes: 0, rssBySession: new Map() };

  try {
    const snapshot = new Map<
      number,
      { pid: number; ppid: number; rss: number }
    >();
    for (const row of (await read()).trim().split("\n")) {
      const [pid, ppid, rss] = row.trim().split(/\s+/).map(Number);
      if (
        validPid(pid) &&
        Number.isSafeInteger(ppid) &&
        ppid >= 0 &&
        Number.isSafeInteger(rss * 1024) &&
        rss >= 0
      )
        snapshot.set(pid, { pid, ppid, rss: rss * 1024 });
    }
    if (snapshot.size === 0) throw new Error("process snapshot is empty");
    const owners = new Map<number, string | null>();
    const children = indexProcessChildren(snapshot.values());
    let missing = 0;
    for (const [root, owner] of roots) {
      if (!snapshot.has(root)) {
        missing++;
        continue;
      }
      for (const pid of getSubtreePids(snapshot, root, children))
        owners.set(pid, owners.has(pid) ? null : owner);
    }
    if (missing)
      report(
        `[HIBERNATE] RSS sample missed ${missing}/${roots.size} registered agent roots`,
      );
    const rssBySession = new Map<string, number>();
    let usedBytes = 0;
    for (const [pid, owner] of owners) {
      const { rss } = snapshot.get(pid)!;
      usedBytes += rss;
      if (owner) rssBySession.set(owner, (rssBySession.get(owner) ?? 0) + rss);
    }
    return { budgetBytes, usedBytes, rssBySession };
  } catch {
    report(
      `[HIBERNATE] RSS sample unavailable (failures=${++failures}); retrying next pass`,
    );
  }
}

export function memoryParkingPicks(
  eligible: HibernationCandidate[],
  memory: ParkingMemory | undefined,
  limit: number,
): HibernationCandidate[] {
  if (!underPressure(memory)) return [];
  const ranked = eligible.flatMap((candidate) => {
    const rss = memory.rssBySession.get(candidate.sessionId);
    return rss && rss > 0 ? [{ candidate, rss }] : [];
  });
  ranked.sort((a, b) => b.rss - a.rss);
  const picked: HibernationCandidate[] = [];
  let remaining = memory.usedBytes - Math.floor(memory.budgetBytes * 0.85);
  for (const { candidate, rss } of ranked) {
    if (picked.length >= limit || remaining <= 0) break;
    picked.push(candidate);
    remaining -= rss;
  }
  return picked;
}

export function interlock(
  sync: Pick<SyncService, "getClient"> | null,
  token: () => string | null,
) {
  return async (
    conversation_id: string,
    session_id: string,
  ): Promise<boolean> => {
    const bearer = token();
    return !!(
      sync &&
      bearer &&
      (await sync.getClient().query(canParkSession, {
        bearer,
        conversation_id,
        session_id,
      })) === true
    );
  };
}
