import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { execFileAsync } from "../proc.js";
import { parseFootprints } from "../watcherMemory.js";

export type WorkerPids = Record<string, number>;

type ProcessSample = {
  rssMiB: number;
  physicalMiB: number;
  cpuSeconds: number;
};
type ProcessMeasure = {
  rssPeakMiB: number;
  physicalPeakMiB: number;
  cpuCores: number;
};

const MiB = 1024 * 1024;
const intervalMs = 500;
const options = { timeout: 5000, maxBuffer: 1024 * 1024 };
let linuxTicks: Promise<number> | undefined;

async function processSample(
  pids: WorkerPids,
): Promise<Record<string, ProcessSample>> {
  const entries = Object.entries(pids);
  if (process.platform === "linux") {
    const ticks = await (linuxTicks ??= execFileAsync(
      "/usr/bin/getconf",
      ["CLK_TCK"],
      options,
    ).then(({ stdout }) => {
      const rate = Number(stdout.trim());
      assert.ok(Number.isSafeInteger(rate) && rate > 0, "invalid CLK_TCK");
      return rate;
    }));
    return Object.fromEntries(
      await Promise.all(
        entries.map(async ([name, pid]) => {
          const [stat, memory] = await Promise.all([
            readFile(`/proc/${pid}/stat`, "utf8"),
            readFile(`/proc/${pid}/smaps_rollup`, "utf8"),
          ]);
          const fields = stat
            .slice(stat.lastIndexOf(")") + 2)
            .trim()
            .split(/\s+/);
          const cpuSeconds = (Number(fields[11]) + Number(fields[12])) / ticks;
          assert.ok(
            Number.isFinite(cpuSeconds) && cpuSeconds >= 0,
            `invalid CPU time for PID ${pid}`,
          );
          const rss = /^Rss:\s+(\d+) kB$/m.exec(memory);
          const pss = /^Pss:\s+(\d+) kB$/m.exec(memory);
          assert.ok(rss && pss, `missing RSS or PSS for PID ${pid}`);
          return [
            name,
            {
              rssMiB: Number(rss[1]) / 1024,
              physicalMiB: Number(pss[1]) / 1024,
              cpuSeconds,
            },
          ];
        }),
      ),
    );
  }

  assert.equal(
    process.platform,
    "darwin",
    "worker load benchmark needs macOS or Linux",
  );
  const ids = entries.map(([, pid]) => String(pid));
  const [ps, footprint] = await Promise.all([
    execFileAsync(
      "/bin/ps",
      ["-o", "pid=,rss=,time=", "-p", ids.join(",")],
      options,
    ),
    execFileAsync(
      "/usr/bin/footprint",
      ["--noCategories", ...ids.flatMap((pid) => ["-p", pid])],
      options,
    ),
  ]);
  const physical = parseFootprints(footprint.stdout);
  const rows = new Map(
    ps.stdout
      .trim()
      .split("\n")
      .map((line) => {
        const [pid, rss, time] = line.trim().split(/\s+/);
        const cpuSeconds = time
          .split(":")
          .reduce((sum, part) => sum * 60 + Number(part), 0);
        assert.ok(Number.isFinite(cpuSeconds) && Number(rss) > 0);
        return [
          Number(pid),
          { rssMiB: Number(rss) / 1024, cpuSeconds },
        ] as const;
      }),
  );
  return Object.fromEntries(
    entries.map(([name, pid]) => {
      const row = rows.get(pid);
      const footprintBytes = physical.get(pid)?.now;
      assert.ok(
        row && footprintBytes && footprintBytes > 0,
        `missing RSS or footprint for PID ${pid}`,
      );
      return [name, { ...row, physicalMiB: footprintBytes / MiB }];
    }),
  );
}

export async function sampleWorkerResources(pids: WorkerPids) {
  const first = await processSample(pids);
  const begin = performance.now();
  const samples = [first];
  const cancel = new AbortController();
  let samplingFailure: unknown;
  const running = (async () => {
    while (!cancel.signal.aborted) {
      await delay(intervalMs, undefined, { signal: cancel.signal }).catch(
        () => {},
      );
      if (!cancel.signal.aborted) samples.push(await processSample(pids));
    }
  })().catch((error) => {
    samplingFailure = error;
  });

  return async (complete = true) => {
    cancel.abort();
    await running;
    if (!complete) return null;
    if (samplingFailure) throw samplingFailure;
    const last = await processSample(pids);
    const seconds = (performance.now() - begin) / 1000;
    samples.push(last);
    const processes: Record<string, ProcessMeasure> = Object.fromEntries(
      Object.keys(pids).map((name) => [
        name,
        {
          rssPeakMiB: Math.max(...samples.map((sample) => sample[name].rssMiB)),
          physicalPeakMiB: Math.max(
            ...samples.map((sample) => sample[name].physicalMiB),
          ),
          cpuCores: (last[name].cpuSeconds - first[name].cpuSeconds) / seconds,
        },
      ]),
    );
    const peak = (key: "rssMiB" | "physicalMiB") =>
      Math.max(
        ...samples.map((sample) =>
          Object.values(sample).reduce((sum, row) => sum + row[key], 0),
        ),
      );
    return {
      samples: samples.length,
      processes,
      rssPeakMiB: peak("rssMiB"),
      physicalPeakMiB: peak("physicalMiB"),
      cpuCores: Object.values(processes).reduce(
        (sum, row) => sum + row.cpuCores,
        0,
      ),
    };
  };
}

export type WorkerResourceMeasure = NonNullable<
  Awaited<ReturnType<Awaited<ReturnType<typeof sampleWorkerResources>>>>
>;
