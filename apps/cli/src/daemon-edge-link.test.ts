import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createDaemonEdgeLink } from "./daemon-edge-link";

const fetchTarget: {
  fetch(...args: Parameters<typeof fetch>): ReturnType<typeof fetch>;
} = globalThis;

const connection = {
  siteUrl: "https://edge.invalid",
  bearer: "test-secret",
  machine: "m",
  boot: "b",
};
const capacity = {
  memory_total_bytes: 10,
  memory_available_bytes: 5,
  live_agents: 0,
};
const policy = {
  revision: 1,
  heartbeat_interval_ms: 30_000,
  uplink_interval_ms: 250,
  limits: { max_batch_events: 10, max_batch_bytes: 100, max_blob_bytes: 100 },
  capabilities: ["heartbeat"],
};
const hello = () => Response.json({ status: "ok", version: 1, policy });
const heartbeat = (revision = 1) =>
  Response.json({ v: 1, policy_revision: revision });
let now: number;
let link: ReturnType<typeof createDaemonEdgeLink>;
let fetchMock: ReturnType<typeof spyOn<typeof fetchTarget, "fetch">>;
let clock: ReturnType<typeof spyOn<typeof performance, "now">>;
let logs: string[];

beforeEach(() => {
  now = 45_000;
  link = createDaemonEdgeLink();
  logs = [];
  clock = spyOn(performance, "now").mockImplementation(() => now);
  fetchMock = spyOn(fetchTarget, "fetch").mockImplementation(() => {
    throw Error("Unexpected edge fetch");
  });
});

afterEach(async () => {
  await link.close();
  fetchMock.mockRestore();
  clock.mockRestore();
});

const tick = (target = connection) =>
  link.tick(target, capacity, [], (message) => logs.push(message));
const paths = () =>
  fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname);

test.each([
  ["late", [30_201, 60_005, 90_200, 120_003]],
  ["alternating", [29_995, 60_005, 89_995, 120_005]],
  ["after a slow hello", [29_900, 60_050, 89_900, 120_050]],
])("%s ticks each send one heartbeat", async (_name, offsets) => {
  fetchMock.mockImplementation(async (input) =>
    String(input).endsWith("/hello") ? hello() : heartbeat(),
  );
  await tick();
  for (const offset of offsets) {
    now = 45_000 + offset;
    await tick();
    await tick();
  }
  expect(paths()).toEqual([
    "/edge/v1/hello",
    ...Array<string>(4).fill("/edge/v1/heartbeat"),
  ]);
});

test("a tick far before the target sends nothing", async () => {
  fetchMock.mockImplementation(async (input) =>
    String(input).endsWith("/hello") ? hello() : heartbeat(),
  );
  await tick();
  now += 27_999;
  await tick();
  expect(paths()).toEqual(["/edge/v1/hello"]);
});

test.each(["siteUrl", "bearer", "machine", "boot"] as const)(
  "a new %s starts a new link",
  async (field) => {
    fetchMock.mockImplementation(async () => hello());
    await tick();
    await tick({
      ...connection,
      [field]: field === "siteUrl" ? "https://other.invalid" : "next",
    });
    expect(paths()).toEqual(["/edge/v1/hello", "/edge/v1/hello"]);
  },
);

test("policy revision changes trigger hello on the next tick", async () => {
  fetchMock.mockImplementation(async (input) =>
    String(input).endsWith("/hello") ? hello() : heartbeat(2),
  );
  await tick();
  now += 30_000;
  await tick();
  await tick();
  expect(paths()).toEqual([
    "/edge/v1/hello",
    "/edge/v1/heartbeat",
    "/edge/v1/hello",
  ]);
});

test("version refusal stops the link until credentials change", async () => {
  fetchMock
    .mockImplementationOnce(async () =>
      Response.json({ status: "upgrade_required", supported_versions: [] }),
    )
    .mockImplementation(async () => hello());
  await tick();
  now += 600_000;
  await tick();
  expect(paths()).toEqual(["/edge/v1/hello"]);
  expect(logs).toEqual(["[EDGE] hello: upgrade_required (update required)"]);
  await tick({ ...connection, bearer: "updated-token" });
  expect(fetchMock.mock.calls[1]?.[1]?.headers).toHaveProperty("get");
  expect(
    new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("Authorization"),
  ).toBe("Bearer updated-token");
});

test("rejected hello backs off up to five minutes and keeps credentials out of logs", async () => {
  fetchMock.mockImplementation(async () =>
    Response.json(
      {
        v: 1,
        status: "error",
        code: connection.bearer,
        retryable: false,
      },
      { status: 401 },
    ),
  );
  await tick();
  for (const delay of [30_000, 60_000, 120_000, 240_000, 300_000, 300_000]) {
    const calls = paths().length;
    now += delay - 1;
    await tick();
    expect(paths()).toHaveLength(calls);
    now++;
    await tick();
    expect(paths()).toHaveLength(calls + 1);
  }
  expect(logs).toEqual(Array<string>(7).fill("[EDGE] hello: rejected"));
});

for (const status of [429, 503]) {
  test(`hello and heartbeat honor a ${status} retry hint`, async () => {
    const limit = () =>
      Response.json(
        {
          v: 1,
          status: "error",
          code: "limited",
          retryable: true,
          retry_after_ms: 90_000,
        },
        { status },
      );
    fetchMock
      .mockImplementationOnce(async () => limit())
      .mockImplementationOnce(async () => hello())
      .mockImplementationOnce(async () => limit())
      .mockImplementation(async () => heartbeat());
    await tick();
    now += 89_999;
    await tick();
    expect(paths()).toEqual(["/edge/v1/hello"]);
    now++;
    await tick();
    now += 30_000;
    await tick();
    now += 89_999;
    await tick();
    expect(paths()).toEqual([
      "/edge/v1/hello",
      "/edge/v1/hello",
      "/edge/v1/heartbeat",
    ]);
    now++;
    await tick();
    expect(paths()).toHaveLength(4);
  });
}

for (const action of ["change connection", "shutdown"]) {
  test(`${action} aborts an in-flight hello and suppresses stale errors`, async () => {
    const started = Promise.withResolvers<AbortSignal>();
    fetchMock
      .mockImplementationOnce((_input, init) => {
        const signal = init?.signal;
        if (!signal) throw Error("Edge fetch requires a signal");
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
          started.resolve(signal);
        });
      })
      .mockImplementation(async () => hello());
    const pending = tick();
    const signal = await started.promise;
    await tick();
    expect(paths()).toEqual(["/edge/v1/hello"]);
    if (action === "shutdown") {
      await link.close();
      await tick({ ...connection, boot: "next" });
      expect(paths()).toHaveLength(1);
    } else {
      await tick({ ...connection, boot: "next" });
      expect(paths()).toEqual(["/edge/v1/hello", "/edge/v1/hello"]);
    }
    expect(signal.aborted).toBe(true);
    await pending;
    expect(logs).toEqual([]);
  });
}

test("a transport defect is isolated from the caller and backs off", async () => {
  fetchMock.mockImplementation(() => {
    throw Error(connection.bearer);
  });
  await tick();
  await tick();
  expect(paths()).toEqual(["/edge/v1/hello"]);
  expect(logs).toEqual(["[EDGE] Link failed"]);
});
