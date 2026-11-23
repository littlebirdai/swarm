import { agentOfRow } from "../processTable.js";
import { execFileAsync } from "../proc.js";
import type { MemorySample } from "./memoryStats.js";

const SAMPLE_INTERVAL_MS = 5_000;
const isPid = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 1;

export async function sampleDaemonMemory(pid: number, port: number, headers: Record<string, string> | null): Promise<MemorySample> {
  const inventory = await readInventory(pid, port, headers);
  if (process.platform === "win32") return { daemonRssBytes: inventory?.rssBytes ?? null, agents: null };

  const pids = new Set([pid, ...(inventory?.agentPids ?? [])]);
  const { stdout } = await execFileAsync("ps", ["-ww", "-o", "pid=,rss=,lstart=,args=", "-p", [...pids].join(",")], {
    // Agents carry their launch prompt in argv, so 200 of them print well past
    // the 1 MB default; an overflow would read as "no agents" (processTable.ts).
    timeout: 2_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" },
  }).catch(() => ({ stdout: "" }));

  let daemonRssBytes = inventory?.rssBytes ?? null;
  const agents: MemorySample["agents"] = inventory?.agentPids && stdout.trim() ? [] : null;
  for (const line of stdout.split("\n")) {
    const row = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)(?:\s+(.*))?$/.exec(line);
    if (!row) continue;
    const processPid = Number(row[1]);
    const rssBytes = Number(row[2]) * 1024;
    if (processPid === pid) daemonRssBytes = rssBytes;
    else if (pids.has(processPid) && rssBytes > 0 && agents) {
      const provider = agentOfRow({ comm: "", args: row[4] ?? "" }) ?? "unknown";
      agents.push({ identity: `${processPid}:${row[3]}`, provider, rssBytes });
    }
  }
  return { daemonRssBytes, agents };
}

async function readInventory(pid: number, port: number, headers: Record<string, string> | null) {
  if (!headers) return null;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/bench/processes`, {
      headers, redirect: "error", signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) return null;
    const body = await response.json() as { pid?: unknown; rssBytes?: unknown; agentPids?: unknown };
    if (body.pid !== pid) return null;
    return {
      rssBytes: typeof body.rssBytes === "number" && Number.isSafeInteger(body.rssBytes) && body.rssBytes > 0 ? body.rssBytes : null,
      agentPids: Array.isArray(body.agentPids) && body.agentPids.every(isPid) ? body.agentPids : null,
    };
  } catch {
    return null;
  }
}

export async function startMemorySampling(read: () => Promise<MemorySample>) {
  const samples: MemorySample[] = [];
  const sample = async () => {
    samples.push(await read().catch(() => ({ daemonRssBytes: null, agents: null })));
  };
  await sample();
  let pending: Promise<void> | undefined;
  const timer = setInterval(() => {
    pending ??= sample().finally(() => { pending = undefined; });
  }, SAMPLE_INTERVAL_MS);
  return async () => {
    clearInterval(timer);
    await pending;
    await sample();
    return samples;
  };
}
