import { expect, test } from "bun:test";
import {
  pruneHibernationRefusals,
  rememberHibernationRefusal,
  selectHibernationCandidates,
  type HibernationCandidate,
} from "./hibernation.js";
import { sampleParkingMemory } from "./memory-parking.js";

function idle(
  sessionId: string,
  status: HibernationCandidate["status"] = "idle",
): HibernationCandidate {
  return {
    sessionId,
    tmux: sessionId,
    status,
    awakeIdleMs: 30_000,
    statusDwellMs: 30_000,
    attachedClients: 0,
    sharedPane: false,
    subagentActiveAgoMs: Infinity,
    resumedAgoMs: Infinity,
    messagesInFlight: false,
  };
}

test("memory pressure parks the largest measured idle sessions first", () => {
  const candidates = [
    idle("lighter"),
    idle("heavier"),
    idle("active", "working"),
    idle("permission", "permission_blocked"),
    { ...idle("delivering"), messagesInFlight: true },
    idle("unmeasured"),
  ];
  const rssBySession = new Map([
    ["lighter", 13],
    ["heavier", 25],
    ["active", 45],
    ["permission", 32],
    ["delivering", 40],
  ]);
  const policy = { maxLive: 0, idleMs: 0, maxPerPass: 5 };
  const below = { budgetBytes: 200, usedBytes: 179, rssBySession };
  expect(
    selectHibernationCandidates(candidates, { ...policy, memory: below })
      .picked,
  ).toEqual([]);
  const pressure = { ...below, usedBytes: 200 };
  const { picked, skips } = selectHibernationCandidates(candidates, {
    ...policy,
    memory: pressure,
  });
  expect(picked.map(({ sessionId }) => sessionId)).toEqual([
    "heavier",
    "lighter",
  ]);
  expect(skips).toEqual([
    "status-working",
    "status-working",
    "in-flight-messages",
  ]);
});

test("200 measured agents get below budget with bounded batches of safe parks", () => {
  const MiB = 1024 ** 2;
  let fleet = Array.from({ length: 200 }, (_, index) => idle(String(index)));
  const rssBySession = new Map(
    fleet.map(({ sessionId }, index) => [
      sessionId,
      (index < 10 ? 128 : 32) * MiB,
    ]),
  );
  const budgetBytes = 7_000 * MiB;
  const size = () =>
    fleet.reduce((sum, { sessionId }) => sum + rssBySession.get(sessionId)!, 0);
  expect(size()).toBe(7_360 * MiB);
  const parked = [];
  for (let pass = 0; pass < 3; pass++) {
    const { picked } = selectHibernationCandidates(fleet, {
      maxLive: 0,
      idleMs: 0,
      maxPerPass: 5,
      memory: { budgetBytes, usedBytes: size(), rssBySession },
    });
    parked.push(picked.length);
    fleet = fleet.filter((candidate) => !picked.includes(candidate));
  }
  expect(parked).toEqual([5, 5, 0]);
  expect(size()).toBe(6_080 * MiB);
});

test.skipIf(process.platform === "win32")(
  "shared process RSS is counted once and is not credited to either session",
  async () => {
    const memory = await sampleParkingMemory(
      1024,
      new Map([
        ["parent", { pid: process.pid }],
        ["child", { pid: process.pid }],
      ]),
    );
    expect(memory?.usedBytes).toBeGreaterThan(0);
    expect(memory?.rssBySession.size).toBe(0);
  },
);

test("counts descendants and credits overlapping roots only for exclusive RSS", async () => {
  const logs: string[] = [];
  const memory = await sampleParkingMemory(
    100,
    new Map([
      ["root", { pid: 20 }],
      ["nested", { pid: 22 }],
      ["elsewhere", { pid: 30 }],
      ["missing", { pid: 40 }],
    ]),
    (line) => logs.push(line),
    async () =>
      [
        "20 2 100",
        "21 20 200",
        "22 20 400",
        "23 22 800",
        "30 2 300",
        "31 30 600",
        "99 2 1000",
      ].join("\n"),
  );
  expect(memory?.usedBytes).toBe(2400 * 1024);
  expect([...(memory?.rssBySession ?? [])]).toEqual([
    ["root", 300 * 1024],
    ["elsewhere", 900 * 1024],
  ]);
  expect(logs).toEqual([
    "[HIBERNATE] RSS sample missed 1/4 registered agent roots",
  ]);
});

test("invalid agent PIDs never trigger a process scan", async () => {
  let probes = 0;
  const memory = await sampleParkingMemory(
    100,
    new Map(
      [NaN, 1, 0, -9, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1].map(
        (pid, i) => [String(i), { pid }],
      ),
    ),
    () => {},
    async () => {
      probes++;
      return "";
    },
  );
  expect(probes).toBe(0);
  expect(memory?.usedBytes).toBe(0);
});

test("reports process probe failures and measures again on the next pass", async () => {
  const logs: string[] = [];
  const report = (line: string) => logs.push(line);
  const roots = new Map([["root", { pid: 42 }]]);
  const fail = async () => {
    throw new Error("ps timed out");
  };
  expect(await sampleParkingMemory(100, roots, report, fail)).toBeUndefined();
  expect(await sampleParkingMemory(100, roots, report, fail)).toBeUndefined();
  expect(logs).toEqual([
    expect.stringMatching(/failures=1.*retrying next pass/),
    expect.stringMatching(/failures=2.*retrying next pass/),
  ]);
  expect(
    (await sampleParkingMemory(100, roots, report, async () => "42 2 42"))
      ?.usedBytes,
  ).toBe(42 * 1024);
});

test("the maintenance tick runs a memory-only pass between scheduled reaps", async () => {
  const daemon = await Bun.file(new URL("./daemon.ts", import.meta.url)).text();
  const maintenance = daemon.slice(
    daemon.indexOf("async function runHeartbeatMaintenance("),
    daemon.indexOf("async function runHeartbeatMaintenance(") + 4000,
  );
  expect(maintenance).toMatch(
    /if \(memoryParking\.enabled\(\) && tick % REAP_EVERY_N_FLUSHES !== 0\)\s+await runHibernationPass\(\{\}, true\)/,
  );
});

test("a durable refusal keeps its hour while missing evidence retries after 30 seconds", () => {
  const refusals = new Map<string, number>();
  rememberHibernationRefusal(refusals, "pinned", "pinned", 0);
  rememberHibernationRefusal(
    refusals,
    "unavailable",
    "evidence-unavailable",
    0,
  );
  pruneHibernationRefusals(refusals, 30_000);
  expect([...refusals]).toEqual([["pinned", 3_600_000]]);
  pruneHibernationRefusals(refusals, 3_600_000);
  expect(refusals.size).toBe(0);
});

test("the parking ps snapshot requests only PID, parent PID and RSS", async () => {
  const source = await Bun.file(
    new URL("./memory-parking.ts", import.meta.url),
  ).text();
  expect(source).toMatch(/execFileAsync\("ps", \["-eo", "pid=,ppid=,rss="\]/);
});
