import { expect, spyOn, test } from "bun:test";
import { startMachine } from "@codecast/edge-supervisor";
import { hashToken } from "../../server/convex/apiTokens";
import { serverTest } from "../../server/test-helpers/database.testkit";
import { fixtureRows } from "../../server/test-helpers/rows.testkit";
import { pollUntil } from "./test-helpers/pollUntil.js";

const fetchTarget: {
  fetch(...args: Parameters<typeof fetch>): ReturnType<typeof fetch>;
} = globalThis;

const machine = "edge-test-machine";
const secret = "edge-test-secret";
const bearer = `${secret}.${machine}`;
const serverEnv = {
  CODECAST_EDGE_MEMORY_PARKING_BYTES: "536870912",
};

test("the supervisor negotiates through the real hello route and reports the parking budget", async () => {
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
  const saved = Object.entries(serverEnv).map(
    ([key]) => [key, process.env[key]] as const,
  );
  Object.assign(process.env, serverEnv);
  const logs: string[] = [];
  const paths: string[] = [];
  const fetchMock = spyOn(fetchTarget, "fetch").mockImplementation(
    async (input, init) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      return t.fetch(path, init);
    },
  );
  const supervisor = await startMachine({ log: (line) => logs.push(line) });
  try {
    expect(await supervisor.memoryParkingBudget()).toBeUndefined();
    await supervisor.connect({
      siteUrl: "https://edge.invalid",
      bearer,
      machine,
      boot: "e2e",
      liveAgents: 2,
      local: true,
    });
    await pollUntil(
      async () => (await supervisor.memoryParkingBudget()) === 536870912,
      "parking budget from the hello policy",
    );
    expect(paths).toEqual(["/edge/v1/hello"]);
    expect(
      await t.run(({ db }) => db.query("ip_rate_limits").collect()),
    ).toMatchObject([{ count: 1 }]);
    expect(await t.run(({ db }) => db.query("devices").collect())).toEqual([]);
    expect(logs).toEqual([]);
  } finally {
    await supervisor.close();
    for (const [key, value] of saved)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    fetchMock.mockRestore();
  }
});
