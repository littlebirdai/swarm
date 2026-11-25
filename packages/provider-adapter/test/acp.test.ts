import { afterEach, beforeEach, expect, spyOn } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AnswerRequest,
  InterruptRequest,
  ResumeSpec,
  SessionScope,
  SteerRequest,
} from "@codecast/provider-contract";
import {
  providerConformance,
  type ProviderEffect,
  type ProviderFixture,
} from "@codecast/provider-contract/test";
import { waitFor } from "@codecast/test-helpers/waitFor";
import { it } from "@codecast/effect-kit/effect/testing";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import {
  createProviderAdapter,
  type AcpOwnedSession,
  type RawProviderFrame,
} from "../src";
import { ProviderAdapter, providerAdapterLayer } from "../src/effect";

const scope = { session: "session-1", run: 1, afterSeq: 10 };
const expected = { run: scope.run, fencing_token: "fixture-fence" };
const author = { kind: "person", id: "owner" } as const;
const steer: SteerRequest = {
  expected: { ...expected, turn: null },
  delivery_id: "delivery",
  authors: [author],
  input: [{ type: "text", text: "list the files here" }],
};
const interrupt: InterruptRequest = { expected: { ...expected, turn: "1:1" } };
const answer: AnswerRequest = {
  expected: { ...expected, prompt_id: "1:permission:string:permission" },
  by: author,
  answer: "allow",
};
const bestEffort = {
  status: "in-doubt",
  reason: "best-effort",
  code: "no-receipt",
  message: "ACP does not record delivery IDs",
} as const;
const controlOutcome = {
  status: "in-doubt",
  reason: "best-effort",
  code: "no-control-ack",
  message: "ACP does not acknowledge this control write",
} as const;
const closeError = Object.assign(new Error("fixture kill denied"), {
  code: "EPERM",
});
const bufferCapacity = 32;
const fixtureScript = join(import.meta.dir, "fake-acp.ts");
const originalKill = process.kill.bind(process);
const groups = new Map<number, { calls: number; fail: boolean }>();
const cleanups: (() => Promise<void>)[] = [];

beforeEach(() => {
  spyOn(process, "kill").mockImplementation((pid, signal) => {
    const group = groups.get(-pid);
    if (group) {
      group.calls++;
      if (group.fail) throw closeError;
    }
    return originalKill(pid, signal);
  });
});

afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  } finally {
    groups.clear();
    (process.kill as ReturnType<typeof spyOn>).mockRestore();
  }
});

const recorded = readFileSync(
  join(
    import.meta.dir,
    "../../../apps/cli/src/__fixtures__/grok/linear-tools.jsonl",
  ),
  "utf8",
)
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));

function fixture(env: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "adapter-acp-"));
  const effectsPath = join(directory, "effects");
  const command = [process.execPath, fixtureScript, directory] as const;
  const raw: RawProviderFrame[] = [];
  let fault: Error | undefined;
  const atBackpressure = Promise.withResolvers<void>();
  const options = {
    provider: { agent: "grok", version: "1.0.13" },
    command,
    env,
    retainRaw(frame: RawProviderFrame) {
      raw.push(frame);
      if (frame.line.includes(`"fixtureBuffer":${bufferCapacity}`))
        setImmediate(atBackpressure.resolve);
      if (fault && frame.line === "fixture defect") throw fault;
    },
  };
  const client = createProviderAdapter(options);
  const spec = { ...scope, ...expected, cwd: directory };
  let session: AcpOwnedSession | undefined;
  let group: { calls: number; fail: boolean } | undefined;
  let pid: number | undefined;
  let queued = 0;
  let running = false;

  cleanups.push(async () => {
    await client.dispose();
    if (pid && group?.fail) {
      try {
        originalKill(-pid, "SIGKILL");
      } catch (error) {
        if (
          !(error instanceof Error && "code" in error && error.code === "ESRCH")
        )
          throw error;
      }
    }
    rmSync(directory, { recursive: true, force: true });
  });

  const observed = () =>
    existsSync(effectsPath)
      ? readFileSync(effectsPath, "utf8")
          .trim()
          .split("\n")
          .map(
            (line) =>
              JSON.parse(line) as {
                action: ProviderEffect;
                message: { params?: { prompt?: unknown[] }; result?: unknown };
              },
          )
      : [];

  async function wrote(command: object, barrier = true) {
    const index = String(++queued).padStart(6, "0");
    const barrierId = `barrier:${index}`;
    const temporary = join(directory, `${index}.tmp`);
    writeFileSync(
      temporary,
      JSON.stringify({
        ...command,
        ...(barrier ? { barrier: barrierId } : {}),
      }),
    );
    renameSync(temporary, join(directory, `${index}.command`));
    if (barrier)
      expect(
        await waitFor(() => existsSync(join(directory, barrierId)), 2500, 5),
      ).toBe(true);
  }

  let bootstrap = 0;
  const attach = (result: Awaited<ReturnType<typeof client.start>>) => {
    if (result.status !== "opened") return result;
    pid = Number(readFileSync(join(directory, "pid"), "utf8"));
    group = { calls: 0, fail: false };
    groups.set(pid, group);
    running = true;
    const owned = result.session;
    session = owned;
    return {
      status: "opened" as const,
      session: {
        ...owned,
        async steer(request: SteerRequest) {
          const before = observed().length;
          const result = await owned.steer(request);
          if (result.status === "in-doubt")
            expect(
              await waitFor(() => observed().length > before, 2500, 5),
            ).toBe(true);
          return result;
        },
        async interrupt(request: InterruptRequest) {
          const before = observed().length;
          const result = await owned.interrupt(request);
          if (result.status === "in-doubt")
            expect(
              await waitFor(() => observed().length > before, 2500, 5),
            ).toBe(true);
          return result;
        },
        async answer(request: AnswerRequest) {
          const before = observed().length;
          const result = await owned.answer(request);
          if (result.status === "in-doubt")
            expect(
              await waitFor(() => observed().length > before, 2500, 5),
            ).toBe(true);
          return result;
        },
        close() {
          running = false;
          return owned.close();
        },
      },
    };
  };

  const contract: ProviderFixture = {
    adapter: {
      ...client,
      start: async (spec) => attach(await client.start(spec)),
      resume: async (spec) => attach(await client.resume(spec)),
    },
    mode: "own",
    scope,
    steer,
    interrupt,
    answer,
    orderedEvents: [
      { kind: "context", body: { data: { availableCommands: [] } } },
      {
        kind: "tool.call",
        body: {
          call_id: "call_synthbash01",
          name: "bash",
          input: { command: "ls" },
        },
      },
    ],
    nonReceiptDelivery: bestEffort,
    interruptOutcome: controlOutcome,
    answerOutcome: controlOutcome,
    bufferCapacity,
    open(nextScope: SessionScope) {
      return this.adapter.start({ ...spec, ...nextScope });
    },
    resumeSpec(checkpoint): ResumeSpec {
      return { ...spec, run: 2, checkpoint };
    },
    async sendEvent(index) {
      if (!running) return;
      const frame =
        index === 1
          ? recorded[5]
          : { method: "session/update", params: recorded[0] };
      await wrote({
        frame: {
          ...frame,
          params: {
            ...frame.params,
            sessionId: session?.getCheckpoint(),
            _meta: { fixtureBuffer: index },
          },
        },
      });
    },
    backpressure: { kind: "block", wait: () => atBackpressure.promise },
    async atActiveTurn(run) {
      bootstrap++;
      const before = observed().length;
      expect(await session?.steer(steer)).toEqual(bestEffort);
      expect(await waitFor(() => observed().length > before, 2500, 5)).toBe(
        true,
      );
      return run();
    },
    async atPendingPrompt(run) {
      await wrote({
        frame: {
          id: "permission",
          method: "session/request_permission",
          params: {
            sessionId: session?.getCheckpoint(),
            toolCall: { toolCallId: "tool", title: "Read files" },
            options: [
              { optionId: "allow", name: "Allow", kind: "allow_once" },
              { optionId: "always", name: "Remember", kind: "allow_always" },
              { optionId: "deny", name: "Deny", kind: "reject_once" },
            ],
          },
        },
      });
      return run();
    },
    async processExit() {
      await wrote({ exit: true }, false);
    },
    async streamDefect(error) {
      fault = error;
      await wrote({ raw: "fixture defect" }, false);
    },
    failClose() {
      if (!group) throw new Error("No process group");
      group.fail = true;
      return {
        status: "failed",
        code: "kill-failed",
        message: String(closeError),
      };
    },
    effects() {
      let ignored = 0;
      return observed().flatMap(({ action }) =>
        action === "steer" && ignored++ < bootstrap ? [] : [action],
      );
    },
    releases: () => group?.calls ?? 0,
  };
  return { client, spec, options, contract, raw, observed, wrote, directory };
}

providerConformance("Grok ACP stdio", () => fixture().contract);

it.effect(
  "scoped ownership kills the process group, including a descendant",
  () =>
    Effect.gen(function* () {
      const fake = fixture({ ACP_CHILD: "1" });
      const run = yield* Scope.make();
      const open = Effect.flatMap(ProviderAdapter, (adapter) =>
        adapter.own(fake.spec),
      ).pipe(
        Scope.provide(run),
        Effect.provide(providerAdapterLayer(fake.options)),
      );
      const result = yield* open;
      expect(result.status).toBe("opened");
      const descendant = Number(
        readFileSync(join(fake.directory, "descendant"), "utf8"),
      );
      try {
        yield* Scope.close(run, Exit.void);
        expect(
          yield* Effect.promise(() =>
            waitFor(() => processStopped(descendant), 2500, 5),
          ),
        ).toBe(true);
      } finally {
        if (!processStopped(descendant)) originalKill(descendant, "SIGKILL");
      }
    }),
);

it.effect(
  "retains malformed and replay frames, streams text, and ends the named turn",
  () =>
    Effect.promise(async () => {
      const fake = fixture();
      const opened = await fake.client.resume({
        ...fake.spec,
        checkpoint: "resumed",
      });
      if (opened.status !== "opened") throw new Error(JSON.stringify(opened));
      const session = opened.session;
      try {
        const iterator = session.events[Symbol.asyncIterator]();
        expect(await session.steer(steer)).toEqual(bestEffort);
        expect(await iterator.next()).toMatchObject({
          value: { kind: "turn.started", turn: "1:1", seq: 11 },
        });
        await fake.wrote({ raw: "{broken-frame" });
        for (const frame of recorded.slice(1, 10)) {
          await fake.wrote({
            frame: {
              ...frame,
              params: { ...frame.params, sessionId: "resumed" },
            },
          });
        }
        await fake.wrote({ complete: true });
        const events = [];
        for (
          let item = await iterator.next();
          !item.done;
          item = await iterator.next()
        ) {
          events.push(item.value);
          if (item.value.kind === "turn.ended") break;
        }
        expect(events.map((event) => event.kind)).toEqual([
          "message.user",
          "message.delta",
          "message.delta",
          "message.assistant",
          "tool.call",
          "tool.result",
          "tool.call",
          "tool.result",
          "turn.ended",
        ]);
        expect(events[0]?.body).toEqual({
          text: "list the files here",
          authors: [author],
          delivery_id: "delivery",
        });
        expect(events[2]?.body).toMatchObject({
          text: "let me look.",
          offset: 6,
        });
        expect(events[3]?.body).toMatchObject({ text: "Sure, let me look." });
        expect(events.at(-1)).toMatchObject({
          turn: "1:1",
          body: { reason: "end_turn" },
        });
        expect(fake.raw).toContainEqual({
          session: "session-1",
          run: 1,
          line: "{broken-frame",
          disposition: "unknown",
        });
        expect(fake.raw.some((frame) => frame.disposition === "replay")).toBe(
          true,
        );
        expect(session.getUnknownPayloadCount()).toBe(
          fake.raw.filter((frame) => frame.disposition === "unknown").length,
        );
      } finally {
        await session.close();
      }
    }),
);

it.effect(
  "refuses unregistered versions and reports an ambiguous open after a wire exit",
  () =>
    Effect.promise(async () => {
      const fake = fixture({ ACP_EXIT_ON_NEW: "1" });
      const unknown = createProviderAdapter({
        ...fake.options,
        provider: { agent: "grok", version: "next" },
      });
      try {
        const resumeSpec = { ...fake.spec, checkpoint: "ignored" };
        expect(await unknown.start(resumeSpec)).toEqual({
          status: "unsupported",
          requires: "own",
        });
        expect(existsSync(join(fake.directory, "pid"))).toBe(false);
        expect(await fake.client.start(fake.spec)).toMatchObject({
          status: "in-doubt",
          reason: "unknown",
          code: "channel-ended",
        });
      } finally {
        await unknown.dispose();
      }
    }),
);

function processStopped(pid: number) {
  try {
    originalKill(pid, 0);
    return (
      process.platform === "linux" &&
      /\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"))
    );
  } catch (error) {
    return (
      (error instanceof Error && "code" in error && error.code === "ESRCH") ||
      (error instanceof Error && "code" in error && error.code === "ENOENT")
    );
  }
}

it.effect("aborting a pending open stops the spawned process", () =>
  Effect.promise(async () => {
    const fake = fixture({ ACP_HOLD_NEW: "1" });
    const controller = new AbortController();
    const result = fake.client.start(fake.spec, controller.signal);
    expect(
      await waitFor(
        () => existsSync(join(fake.directory, "new-seen")),
        2500,
        5,
      ),
    ).toBe(true);
    const pid = Number(readFileSync(join(fake.directory, "pid"), "utf8"));
    controller.abort();
    await expect(result).rejects.toThrow();
    expect(await waitFor(() => processStopped(pid), 2500, 5)).toBe(true);
  }),
);

it.effect("disposal closes an owned handle and pending event read", () =>
  Effect.promise(async () => {
    const fake = fixture();
    const opened = await fake.client.start(fake.spec);
    if (opened.status !== "opened") throw new Error(JSON.stringify(opened));
    const { session } = opened;
    const pid = Number(readFileSync(join(fake.directory, "pid"), "utf8"));
    const reading = session.events[Symbol.asyncIterator]().next();
    await fake.client.dispose();
    expect(await reading).toEqual({ done: true, value: undefined });
    expect(processStopped(pid)).toBe(true);
    expect(await session.close()).toEqual({ status: "closed" });
    expect(await session.steer(steer)).toEqual({ status: "closed" });
  }),
);

it.effect(
  "local images are sent with their bytes and close fences preparing input",
  () =>
    Effect.promise(async () => {
      const fake = fixture();
      const image = join(fake.directory, "input.png");
      writeFileSync(image, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const request: SteerRequest = {
        ...steer,
        input: [{ type: "local-image", path: image }, ...steer.input],
      };
      const opened = await fake.contract.open(scope);
      if (opened.status !== "opened") throw new Error(JSON.stringify(opened));
      expect(await opened.session.steer(request)).toEqual(bestEffort);
      expect(fake.observed()[0]?.message.params?.prompt).toEqual([
        { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
        { type: "text", text: "list the files here" },
      ]);
      await opened.session.close();

      const fresh = await fake.client.start(fake.spec);
      if (fresh.status !== "opened") throw new Error(JSON.stringify(fresh));
      const preparing = fresh.session.steer(request);
      const closing = fresh.session.close();
      expect(await preparing).toEqual({ status: "closed" });
      expect(await closing).toEqual({ status: "closed" });
      expect(fake.observed()).toHaveLength(1);
    }),
);

it.effect(
  "permission choices are fenced, validated and translated to ACP option IDs",
  () =>
    Effect.promise(async () => {
      const fake = fixture();
      const opened = await fake.contract.open(scope);
      if (opened.status !== "opened") throw new Error(JSON.stringify(opened));
      try {
        await fake.contract.atPendingPrompt(async () => {
          expect(fake.observed()).toEqual([]);
          expect(
            await opened.session.answer({ ...answer, answer: "unavailable" }),
          ).toMatchObject({
            status: "refused",
            code: "invalid-option",
          });
          expect(
            await opened.session.answer({
              ...answer,
              answer: { behavior: "allow", updatedPermissions: ["remember"] },
            }),
          ).toEqual(controlOutcome);
          expect(fake.observed().map(({ message }) => message.result)).toEqual([
            { outcome: { outcome: "selected", optionId: "always" } },
          ]);
          expect(await opened.session.answer(answer)).toMatchObject({
            status: "stale",
          });
        });
      } finally {
        await opened.session.close();
      }
    }),
);

it.effect("interrupt cancels pending permissions for the named turn", () =>
  Effect.promise(async () => {
    const fake = fixture();
    const opened = await fake.contract.open(scope);
    if (opened.status !== "opened") throw new Error(JSON.stringify(opened));
    try {
      await fake.contract.atActiveTurn(() =>
        fake.contract.atPendingPrompt(async () => {
          expect(await opened.session.interrupt(interrupt)).toEqual(
            controlOutcome,
          );
          expect(
            await waitFor(() => fake.observed().length === 3, 2500, 5),
          ).toBe(true);
          expect(fake.observed().slice(1)).toMatchObject([
            {
              action: "answer",
              message: { result: { outcome: { outcome: "cancelled" } } },
            },
            { action: "interrupt" },
          ]);
          expect(await opened.session.answer(answer)).toMatchObject({
            status: "stale",
          });
        }),
      );
    } finally {
      await opened.session.close();
    }
  }),
);

it.effect("oversized frames are retained in order and counted once", () =>
  Effect.promise(async () => {
    const fake = fixture();
    const opened = await fake.client.start(fake.spec);
    if (opened.status !== "opened") throw new Error(JSON.stringify(opened));
    try {
      const raw = "x".repeat(8 * 1024 * 1024) + "é";
      await fake.wrote({ raw });
      const fragments = fake.raw.filter((frame) => frame.base64Fragment);
      expect(fragments.length).toBeGreaterThan(1);
      expect(fragments.map((frame) => frame.base64Fragment?.index)).toEqual(
        fragments.map((_, index) => index),
      );
      expect(fragments.at(-1)?.base64Fragment?.last).toBe(true);
      expect(
        Buffer.concat(
          fragments.map(({ line }) => Buffer.from(line, "base64")),
        ).toString(),
      ).toBe(raw);
      expect(opened.session.getUnknownPayloadCount()).toBe(2);
    } finally {
      await opened.session.close();
    }
  }),
);

it.effect("a saturated live stream preserves every durable event", () =>
  Effect.promise(async () => {
    const fake = fixture();
    const opened = await fake.contract.open(scope);
    if (opened.status !== "opened") throw new Error(JSON.stringify(opened));
    const { session } = opened;
    try {
      for (let index = 0; index < bufferCapacity; index++)
        await fake.contract.sendEvent(index);
      const excess = fake.contract.sendEvent(bufferCapacity);
      if (fake.contract.backpressure.kind !== "block")
        throw new Error("Expected a pausable source");
      await fake.contract.backpressure.wait();
      const iterator = session.events[Symbol.asyncIterator]();
      const first = await iterator.next();
      await excess;
      await fake.contract.processExit();
      const sequences = [];
      for (let item = first; !item.done; item = await iterator.next()) {
        if (item.value.kind !== "message.delta") sequences.push(item.value.seq);
      }
      expect(sequences).toEqual(
        Array.from({ length: bufferCapacity + 2 }, (_, index) => 11 + index),
      );
    } finally {
      await session.close();
    }
  }),
);
