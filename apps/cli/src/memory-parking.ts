import { makeFunctionReference } from "convex/server";
import { readResidentMemory } from "./bench/memorySampler.js";
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

export async function sampleParkingMemory(
  budgetBytes: number,
  sessions: ReadonlyMap<string, { pid: number }>,
): Promise<ParkingMemory | undefined> {
  const owners = new Map<number, string | null>();
  for (const [sessionId, { pid }] of sessions)
    owners.set(pid, owners.has(pid) ? null : sessionId);
  const memory = await readResidentMemory(new Set(owners.keys()));
  if (!memory) return;
  const rssBySession = new Map<string, number>();
  let usedBytes = 0;
  for (const [pid, { rssBytes }] of memory) {
    usedBytes += rssBytes;
    const owner = owners.get(pid);
    if (owner) rssBySession.set(owner, rssBytes);
  }
  return { budgetBytes, usedBytes, rssBySession };
}

export function memoryParkingPicks(
  eligible: HibernationCandidate[],
  memory: ParkingMemory | undefined,
  limit: number,
): HibernationCandidate[] {
  if (!memory || memory.usedBytes < memory.budgetBytes * 0.9) return [];
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
