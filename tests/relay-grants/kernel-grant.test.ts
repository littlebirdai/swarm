import { expect, spyOn, test } from "bun:test";
import { api } from "../../apps/server/convex/_generated/api";
import {
  asUser,
  serverTest,
} from "../../apps/server/test-helpers/database.testkit";
import { fixtureRows } from "../../apps/server/test-helpers/rows.testkit";

const key = Buffer.alloc(32, 51).toString("base64url");
const previousKey = Buffer.alloc(32, 52).toString("base64url");
const environment = {
  RELAY_HOST: "127.0.0.1",
  RELAY_PORT: "0",
  RELAY_AUDIENCE: "cell-A",
  RELAY_HMAC_KEY: key,
  RELAY_HMAC_PREVIOUS_KEY: previousKey,
};

function exchange(socket: WebSocket, message: object): Promise<unknown> {
  return new Promise((resolve, reject) => {
    socket.addEventListener(
      "message",
      (event) => resolve(JSON.parse(event.data)),
      {
        once: true,
      },
    );
    socket.addEventListener("error", reject, { once: true });
    socket.send(JSON.stringify(message));
  });
}

test("the relay verifies kernel signatures, audience, expiry and same-user tab grants", async () => {
  const prior = Object.entries(environment).map(
    ([name]) => [name, process.env[name]] as const,
  );
  Object.assign(process.env, environment);
  const servers: Bun.Subprocess<"pipe", "ignore", "inherit">[] = [];
  const startRelay = async (overrides: Record<string, string> = {}) => {
    const ready = Promise.withResolvers<URL>();
    const child = Bun.spawn(
      [
        process.execPath,
        import.meta.dir + "/../../apps/relay/test/kernel-grant-peer.ts",
      ],
      {
        env: { ...process.env, ...environment, ...overrides },
        stdin: "pipe",
        stdout: "ignore",
        stderr: "inherit",
        ipc: (message) => ready.resolve(new URL(String(message))),
      },
    );
    servers.push(child);
    return Promise.race([
      ready.promise,
      child.exited.then((code) => {
        throw new Error(`Relay fixture exited before startup (${code})`);
      }),
    ]);
  };
  const sockets: WebSocket[] = [];
  const connect = async (url: URL, token: string) => {
    const address = new URL("/relay", url);
    address.protocol = "ws:";
    const socket = new WebSocket(address);
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    const hello = await exchange(socket, {
      type: "connect",
      versions: [1],
      capabilities: ["presence"],
      token,
    });
    return { socket, hello };
  };

  try {
    const t = serverTest();
    const { owner, id } = await t.run(async ({ db }) => {
      const rows = fixtureRows(db, "kernel-grant-wire");
      const owner = await rows.user();
      return { owner, id: await rows.conversation(owner) };
    });
    const hub = { kind: "session", id } as const;
    const caller = asUser(t, owner);
    const mint = async () => {
      const result = await caller.mutation(api.relayGrants.mint, {
        hubs: [hub],
      });
      if (result.status !== "ok")
        throw new Error(`Mint returned ${result.status}`);
      expect(result.ttl_ms).toBeGreaterThan(0);
      expect(result.ttl_ms).toBeLessThanOrEqual(60_000);
      return result.token;
    };
    const clock = spyOn(Date, "now").mockReturnValue(Date.now() - 120_000);
    let expired: string;
    try {
      expired = await mint();
    } finally {
      clock.mockRestore();
    }
    const first = await mint();
    const second = await mint();
    const third = await mint();

    const relay = await startRelay();
    const firstTab = await connect(relay, second);
    const secondTab = await connect(relay, first);
    for (const tab of [firstTab, secondTab]) {
      expect(tab.hello).toMatchObject({ type: "hello", status: "ok" });
      expect(
        await exchange(tab.socket, { type: "subscribe", v: 1, hub }),
      ).toMatchObject({
        type: "subscription",
        status: "subscribed",
      });
    }
    for (const [tab, token] of [
      [firstTab, third],
      [secondTab, second],
    ] as const) {
      expect(
        await exchange(tab.socket, {
          type: "grant_update",
          v: 1,
          request_id: "refresh",
          token,
        }),
      ).toMatchObject({ type: "grant_result", status: "applied" });
    }

    const unauthorized = { type: "hello", status: "unauthorized" };
    const [version, payload, signature] = first.split(".");
    const replacement = signature[0] === "A" ? "B" : "A";
    const tampered = `${version}.${payload}.${replacement}${signature.slice(1)}`;
    for (const token of [tampered, expired]) {
      expect((await connect(relay, token)).hello).toEqual(unauthorized);
    }

    for (const overrides of [
      { RELAY_AUDIENCE: "other-cell" },
      { RELAY_HMAC_KEY: previousKey, RELAY_HMAC_PREVIOUS_KEY: previousKey },
    ]) {
      const incompatible = await startRelay(overrides);
      expect((await connect(incompatible, first)).hello).toEqual(unauthorized);
    }
  } finally {
    for (const socket of sockets) socket.close();
    for (const server of servers) server.stdin.end();
    await Promise.all(servers.map((server) => server.exited));
    for (const [name, value] of prior) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
