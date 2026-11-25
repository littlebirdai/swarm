import { expect, spyOn, test } from "bun:test";
import { createDaemonEdgeLink } from "./daemon-edge-link";
import { hashToken } from "../../server/convex/apiTokens";
import { serverTest } from "../../server/test-helpers/database.testkit";
import { fixtureRows } from "../../server/test-helpers/rows.testkit";

const fetchTarget: {
  fetch(...args: Parameters<typeof fetch>): ReturnType<typeof fetch>;
} = globalThis;

const machine = "edge-test-machine";
const secret = "edge-test-secret";
const bearer = `${secret}.${machine}`;
const capacity = {
  memory_total_bytes: 1_024,
  memory_available_bytes: 512,
  live_agents: 2,
};
const runtimes = [{ host: "laptop", isolation: "none" }];

test("the daemon facade negotiates and sends heartbeats through the real routes", async () => {
  const t = serverTest();
  const tokenHash = await hashToken(secret);
  await t.run(async ({ db }) => {
    const user = await fixtureRows(db, "edge integration").user();
    await db.insert("api_tokens", {
      user_id: user,
      name: "edge test",
      token_hash: tokenHash,
      created_at: 0,
      last_used_at: 0,
      device_id: machine,
    });
  });
  const flag = process.env.CODECAST_EDGE_V1;
  process.env.CODECAST_EDGE_V1 = "1";
  const link = createDaemonEdgeLink();
  const logs: string[] = [];
  const paths: string[] = [];
  const fetchMock = spyOn(fetchTarget, "fetch").mockImplementation(
    async (input, init) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      return t.fetch(path, init);
    },
  );
  const helloAt = 45_000;
  const heartbeatIntervalMs = 30_000;
  let monotonicNow = helloAt;
  const time = spyOn(performance, "now").mockImplementation(() => monotonicNow);
  try {
    const connection = {
      siteUrl: "https://edge.invalid",
      bearer,
      machine,
      boot: "e2e",
    };
    expect(
      await link.tick(connection, capacity, runtimes, (message) =>
        logs.push(message),
      ),
    ).toBeUndefined();
    monotonicNow = helloAt + heartbeatIntervalMs - 1;
    expect(
      await link.tick(connection, capacity, runtimes, (message) =>
        logs.push(message),
      ),
    ).toBeUndefined();
    expect(paths).toEqual(["/edge/v1/hello"]);
    monotonicNow = helloAt + heartbeatIntervalMs;
    expect(
      await link.tick(connection, capacity, runtimes, (message) =>
        logs.push(message),
      ),
    ).toBeUndefined();
    expect(
      await link.tick(connection, capacity, runtimes, (message) =>
        logs.push(message),
      ),
    ).toBeUndefined();
    expect(paths).toEqual(["/edge/v1/hello", "/edge/v1/heartbeat"]);
    expect(
      await t.run(({ db }) => db.query("ip_rate_limits").collect()),
    ).toMatchObject([{ count: 2 }]);
    expect(await t.run(({ db }) => db.query("devices").collect())).toEqual([]);
    expect(logs).toEqual([]);
  } finally {
    await link.close();
    if (flag === undefined) delete process.env.CODECAST_EDGE_V1;
    else process.env.CODECAST_EDGE_V1 = flag;
    time.mockRestore();
    fetchMock.mockRestore();
  }
});
