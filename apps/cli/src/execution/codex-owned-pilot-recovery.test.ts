import { expect, spyOn, test } from "bun:test";
import { until } from "../../../../tests/codex-driver-parity/peers.js";
import { question } from "../../../../tests/codex-driver-parity/recording.js";
import { observeClaimedTerminal } from "../terminal/terminal-lifecycle.js";
import {
  bindingFor,
  fixture,
  item,
  pending,
  started,
} from "./codex-owned-pilot-fixture.js";

test("startup claim failure leaves legacy work running and the pilot retries a busy claim on the next updates", async () => {
  const f = fixture();
  const realNow = Date.now;
  let offsetMs = 0;
  const nowSpy = spyOn(Date, "now").mockImplementation(
    () => realNow() + offsetMs,
  );
  try {
    f.claimResponses.push(
      new Response(null, { status: 503 }),
      Response.json({ v: 1, status: "busy", retry_after_ms: 0 }),
    );
    const work = [item(f.pilotRequest), item(f.legacyRequest)];
    f.initial(work);
    await f.runtime.start();
    expect(f.actions).toContain("subscribed");
    expect(f.actions).toContain("legacy-start:legacy:1");
    expect(f.actions).toContain("legacy-deliver:legacy:1:1");
    offsetMs += 5_000;
    await f.runtime.processWorkUpdate([
      { ...item(f.pilotRequest), nextDeliverySequence: 1 },
      item(f.legacyRequest),
    ]);
    expect(f.actions).toContain("legacy-deliver:legacy:1:2");
    offsetMs += 10_000;
    await f.runtime.processWorkUpdate([
      { ...item(f.pilotRequest), nextDeliverySequence: 2 },
      item(f.legacyRequest),
    ]);
    expect(f.actions.filter((action) => action === "edge:claim")).toHaveLength(
      3,
    );
    expect(f.logs.join("\n")).toContain("HTTP 503");
    expect(f.logs.join("\n")).toContain("busy");
    expect(f.actions).toContain("edge:events.append");
    expect(
      f.appServer.wire().filter(({ method }) => method === "thread/resume"),
    ).toHaveLength(1);
    expect(f.actions).not.toContain("claim-delivery:pilot:1");
    expect(f.actions).not.toContain("edge:release");
  } finally {
    nowSpy.mockRestore();
    await f.dispose();
  }
});

test("retargeted pilot leaves the old checkpoint parked and drains the next legacy conversation", async () => {
  const f = fixture("retargeted");
  try {
    const old = f.ready(f.pilotRequest, bindingFor(f.pilotRequest, true));
    const activate = spyOn(f.pilot, "activate");
    await f.runtime.processWorkUpdate([
      item(f.pilotRequest, old),
      item(f.legacyRequest),
    ]);
    expect(activate).not.toHaveBeenCalled();
    expect(f.actions).toContain("legacy-deliver:legacy:1:1");
    expect(f.actions).not.toContain("edge:claim");
    expect(f.actions).not.toContain("claim-delivery:pilot:1");
    await f.driver.stop(old);
    await f.driver.quarantine(old, "retargeted");
    expect(f.actions).toContain("legacy-stop:pilot");
    expect(f.actions).toContain("legacy-quarantine:pilot");
  } finally {
    await f.dispose();
  }
});

test("owned current epoch stops before the legacy successor activates and drains", async () => {
  const f = fixture();
  try {
    await f.runtime.processWorkUpdate([item(f.pilotRequest)]);
    const owned = f.ready(f.pilotRequest);
    await f.runtime.processWorkUpdate([
      {
        ...item(f.pilotRequest, owned),
        pendingEpoch: 2,
        pendingPolicy: "drain-current",
        bindings: [pending(f.pilotRequest, owned), pending(f.successor)],
      },
    ]);
    expect(
      f.actions.filter(
        (action) =>
          action !== "edge:events.append" && action !== "edge:permits.next",
      ),
    ).toEqual([
      "edge:claim",
      "legacy-start:pilot:2",
      "edge:release",
      "disposition:pilot:1:stopped",
      "activate:1:2",
      "claim-delivery:pilot:2",
      "legacy-deliver:pilot:2:2",
      "claim-delivery:pilot:2",
    ]);
  } finally {
    await f.dispose();
  }
});

test("the owned driver refuses delivery before effect and reports uncertain adoption", async () => {
  const f = fixture();
  try {
    const binding = bindingFor(f.pilotRequest, true);
    const permit = started(binding, "1");
    await expect(
      f.driver.deliver({
        binding,
        permit,
        delivery: {
          messageId: permit.messageId,
          deliveryId: permit.deliveryId,
          conversationSequence: "1",
          input: [{ type: "text", text: "queued" }],
        },
      }),
    ).resolves.toMatchObject({
      state: "failed-before-effect",
      failure: { code: "OWNED_CODEX_DELIVERY_PENDING" },
    });
    await expect(
      f.driver.adopt({
        ...f.pilotRequest,
        knownHandle: { ...binding },
      }),
    ).resolves.toMatchObject({
      state: "unknown",
      failure: { code: "OWNED_CODEX_START_UNCONFIRMED" },
    });
    expect(f.actions).toEqual([]);
  } finally {
    await f.dispose();
  }
});

test("runtime shutdown waits for the lease release after confirmed provider cleanup", async () => {
  const f = fixture();
  const gate = Promise.withResolvers<void>();
  try {
    await f.runtime.processWorkUpdate([item(f.pilotRequest)]);
    f.pauseRelease(gate.promise);
    let stopped = false;
    const shutdown = Promise.resolve(f.runtime.stop()).then(() => {
      stopped = true;
    });
    await f.releasing.promise;
    expect(stopped).toBe(false);
    gate.resolve();
    await shutdown;
    expect(stopped).toBe(true);
  } finally {
    gate.resolve();
    await f.dispose();
  }
});

test("runtime shutdown retains the edge lease when provider cleanup is unconfirmed", async () => {
  const f = fixture();
  const spawn = Bun.spawn;
  const kill = process.kill.bind(process);
  let denyCleanup = false;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const spawnSpy = spyOn(Bun, "spawn").mockImplementation(((
    ...args: Parameters<typeof Bun.spawn>
  ) => {
    const launched = Reflect.apply(spawn, Bun, args) as ReturnType<
      typeof Bun.spawn
    >;
    const spec = args[0];
    if (
      spec &&
      "cmd" in spec &&
      Array.isArray(spec.cmd) &&
      spec.cmd[0] === f.appServer.executable
    )
      child = launched;
    return launched;
  }) as typeof Bun.spawn);
  const killSpy = spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (denyCleanup && child && pid === -child.pid)
      throw Object.assign(new Error("fixture kill denied"), { code: "EPERM" });
    return kill(pid, signal);
  });
  try {
    await f.runtime.processWorkUpdate([item(f.pilotRequest)]);
    expect(child).toBeDefined();
    f.appServer.send({
      frames: [
        {
          id: "cleanup-question",
          method: "item/tool/requestUserInput",
          params: {
            threadId: f.appServer.thread,
            turnId: f.appServer.turn(3),
            itemId: "ask-item",
            questions: [question],
          },
        },
      ],
    });
    await until(() => f.promptMessages.length === 1, "publish a question");
    const promptId = f.promptMessages[0]?.toolCalls?.[0]?.id;
    if (!promptId) throw new Error("Expected the published question ID");
    denyCleanup = true;
    await f.runtime.stop();
    expect(f.logs.join("\n")).toContain("cleanup could not be confirmed");
    expect(f.actions).not.toContain("edge:release");
    expect(f.promptMessages[1]?.toolResults).toEqual([
      { toolUseId: promptId, content: "Codex question cancelled" },
    ]);
  } finally {
    spawnSpy.mockRestore();
    killSpy.mockRestore();
    if (child) {
      try {
        kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            (error.code === "ESRCH" || error.code === "EPERM")
          )
        )
          throw error;
      }
      await child.exited;
    }
    await f.dispose();
  }
});

test("a granted lease is retained if the provider never opened", async () => {
  const f = fixture();
  try {
    const binding = {
      ...bindingFor(f.pilotRequest, true),
      handle: "owned-codex-v1:{}",
    };
    f.ready(f.pilotRequest, binding);
    await f.runtime.processWorkUpdate([item(f.pilotRequest, binding)]);
    expect(f.logs.join("\n")).toContain("Invalid owned Codex checkpoint");
    await f.runtime.stop();
    expect(f.actions).toEqual(["edge:claim"]);
  } finally {
    await f.dispose();
  }
});

test.each([
  ["once", 2],
  ["conflict", 1],
  ["400", 1],
  ["503", 2],
] as const)(
  "owned Codex keeps its provider stream when terminal start fails with %s",
  async (failure, attempts) => {
    const f = fixture();
    const original = process.env.CODECAST_DIR;
    process.env.CODECAST_DIR = f.journalDirectory;
    try {
      f.failTerminalStart(failure);
      await f.runtime.processWorkUpdate([item(f.pilotRequest)]);
      await observeClaimedTerminal("pilot", "pane", "owner")?.catch(() => {});
      f.appServer.send({
        frames: [
          {
            id: "terminal-recovery-question",
            method: "item/tool/requestUserInput",
            params: {
              threadId: f.appServer.thread,
              turnId: f.appServer.turn(3),
              itemId: "ask-item",
              questions: [question],
            },
          },
        ],
      });
      await until(
        () => f.promptMessages.length === 1,
        "publish after recovering the terminal write",
      );
      expect(f.actions).not.toContain("edge:release");

      await f.runtime.stop();
      const [terminalSeq] = f.terminalStartAttempts;
      expect(terminalSeq).toBeGreaterThan(1);
      expect(f.terminalStartAttempts).toEqual(
        Array(attempts).fill(terminalSeq),
      );
      const providerKinds = [
        "session.started",
        "turn.started",
        "prompt.opened",
        "context",
      ];
      const expected: [number, string][] = [];
      for (let seq = 1; seq <= 5; seq++) {
        if (seq === terminalSeq) {
          if (failure === "once") expected.push([seq, "terminal.started"]);
        } else {
          expected.push([seq, providerKinds.shift()!]);
        }
      }
      expect(
        f.events
          .filter(({ seq }) => seq <= 5)
          .map(({ seq, kind }) => [seq, kind]),
      ).toEqual(expected);
      if (failure === "once") {
        expect(f.events.at(-1)).toMatchObject({
          seq: 6,
          kind: "terminal.ended",
          body: { pane_instance: 1, outcome: { kind: "lost" } },
        });
      }
      if (failure === "conflict" || failure === "400")
        expect(f.events.some(({ kind }) => kind.startsWith("terminal."))).toBe(
          false,
        );
      expect(f.actions).toContain("edge:release");
    } finally {
      try {
        await f.dispose();
      } finally {
        if (original === undefined) delete process.env.CODECAST_DIR;
        else process.env.CODECAST_DIR = original;
      }
    }
  },
);
