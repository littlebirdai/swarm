import { expect, test } from "bun:test";
import {
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
