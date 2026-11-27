import { expect, test } from "bun:test";
import {
  pruneHibernationRefusals,
  rememberHibernationRefusal,
  runHibernationSelection,
  selectHibernationCandidates,
  type HibernationCandidate,
  type HibernationRetry,
} from "./hibernation.js";
import {
  PARKING_INTERLOCK_UNAVAILABLE,
  parkingMemoryRoots,
  sampleParkingMemory,
} from "./memory-parking.js";

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

test("owned Codex RSS pushes the fleet over budget without making its thread parkable", async () => {
  const memory = await sampleParkingMemory(
    100 * 1024,
    parkingMemoryRoots(
      new Map([
        ["legacy", { pid: 20 }],
        ["owned", { pid: 40 }],
      ]),
      {
        ownsThread: (id) => id === "owned",
        getProcessId: () => 30,
      },
    ),
    () => {},
    async () => "20 2 20\n30 2 50\n31 30 30\n40 30 10",
  );
  expect(memory?.usedBytes).toBe(110 * 1024);
  expect([...(memory?.rssBySession ?? [])]).toEqual([["legacy", 20 * 1024]]);
  const { picked } = selectHibernationCandidates(
    [idle("owned"), idle("legacy")],
    { maxLive: 0, idleMs: 0, maxPerPass: 5, memory },
  );
  expect(picked.map(({ sessionId }) => sessionId)).toEqual(["legacy"]);
});

test("parkingMemoryRoots counts every owned Codex child PID without making them parkable", async () => {
  const memory = await sampleParkingMemory(
    100 * 1024,
    parkingMemoryRoots(
      new Map([
        ["legacy", { pid: 20 }],
        ["owned-a", { pid: 40 }],
        ["owned-b", { pid: 50 }],
      ]),
      {
        ownsThread: (id) => id === "owned-a" || id === "owned-b",
        getProcessId: () => undefined,
        getProcessIds: () => [30, 60],
      },
    ),
    () => {},
    async () => "20 2 20\n30 2 45\n40 30 5\n60 2 55\n50 60 10",
  );
  expect(memory?.usedBytes).toBe(135 * 1024);
  expect([...(memory?.rssBySession ?? [])]).toEqual([["legacy", 20 * 1024]]);
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

test("only opted-in transport failures retry early and successive delays grow", () => {
  const refusals = new Map<string, HibernationRetry>();
  rememberHibernationRefusal(
    refusals,
    "local-evidence",
    "evidence-unavailable",
    0,
    true,
  );
  rememberHibernationRefusal(
    refusals,
    "server-prompt",
    "server-parking-prompt",
    0,
    true,
  );
  rememberHibernationRefusal(
    refusals,
    "legacy",
    PARKING_INTERLOCK_UNAVAILABLE,
    0,
  );
  rememberHibernationRefusal(
    refusals,
    "network",
    PARKING_INTERLOCK_UNAVAILABLE,
    0,
    true,
  );
  expect([...pruneHibernationRefusals(refusals, 30_000)]).toEqual([
    "local-evidence",
    "server-prompt",
    "legacy",
    "network",
  ]);
  expect([...pruneHibernationRefusals(refusals, 60_000)]).toEqual([
    "local-evidence",
    "server-prompt",
    "legacy",
  ]);
  rememberHibernationRefusal(
    refusals,
    "network",
    PARKING_INTERLOCK_UNAVAILABLE,
    60_000,
    true,
  );
  expect(pruneHibernationRefusals(refusals, 179_999).has("network")).toBe(true);
  expect(pruneHibernationRefusals(refusals, 180_000).has("network")).toBe(
    false,
  );
  expect(pruneHibernationRefusals(refusals, 3_599_999).size).toBe(3);
  expect(pruneHibernationRefusals(refusals, 3_600_000).size).toBe(0);
});

test("the parking ps snapshot requests only PID, parent PID and RSS", async () => {
  const source = await Bun.file(
    new URL("./memory-parking.ts", import.meta.url),
  ).text();
  expect(source).toMatch(/execFileAsync\("ps", \["-eo", "pid=,ppid=,rss="\]/);
});

for (const memoryEnabled of [false, true]) {
  test(`refusing fleet heads do not starve smaller sessions with memory parking ${memoryEnabled ? "on" : "off"}`, async () => {
    const fleet = Array.from({ length: 8 }, (_, index) => ({
      ...idle(`s${index}`),
      awakeIdleMs: 30_000 + 8 - index,
    }));
    let now = 0;
    const tried: string[] = [];
    const parked = new Set<string>();
    const refusals = new Map<string, HibernationRetry>();
    const pass = () =>
      runHibernationSelection(
        fleet.filter(({ sessionId }) => !parked.has(sessionId)),
        {
          maxLive: 0,
          idleMs: memoryEnabled ? 0 : 1,
          maxPerPass: 5,
          ...(memoryEnabled && {
            memory: {
              budgetBytes: 100,
              usedBytes: 800,
              rssBySession: new Map(
                fleet.map(({ sessionId }, index) => [sessionId, 100 - index]),
              ),
            },
          }),
        },
        refusals,
        {
          now: () => now,
          preview: async () => null,
          attempt: async ({ sessionId }) => {
            tried.push(sessionId);
            if (sessionId < "s5") return "agent-has-children";
            parked.add(sessionId);
            return null;
          },
          report: () => {},
        },
      );

    expect(await pass()).toBe(memoryEnabled ? 3 : 0);
    now += memoryEnabled ? 30_000 : 300_000;
    expect(await pass()).toBe(memoryEnabled ? 0 : 3);
    expect(tried).toEqual(fleet.map(({ sessionId }) => sessionId));
    expect([...parked]).toEqual(["s5", "s6", "s7"]);
  });
}
