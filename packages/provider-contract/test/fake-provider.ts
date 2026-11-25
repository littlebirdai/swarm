import type {
  CloseOutcome,
  ControlOutcome,
  DeliveryOutcome,
  DeliveryReceipt,
  InDoubt,
  ObservedPosition,
  ObservedSession,
  ObserveSpec,
  OwnedSession,
  ProviderAdapter,
  ProviderOffer,
  RunFence,
  StartSpec,
} from "../src";
import type { ProviderEffect, ProviderFixture } from "./conformance";
import { fakeEventStream } from "./fake-event-stream";

const scope = { session: "session-1", run: 1, afterSeq: 10 };
const fence = "fence-1";
const turn = "turn-1";
const prompt = "prompt-1";
const pane = 1;
const checkpoint = "checkpoint";
const author = { kind: "person", id: "owner" } as const;
const bufferCapacity = 1;
const closeFailure = {
  status: "failed",
  code: "CLOSE_FAILED",
  message: "Release failed",
} as const;
const closed = { status: "closed" } as const;
const bestEffort = {
  status: "in-doubt",
  reason: "best-effort",
  code: "NO_DURABLE_RECEIPT",
  message: "The transport accepted the write",
} as const satisfies InDoubt;

function stale<Position extends ObservedPosition>(observed: Position) {
  return { status: "stale", observed } as const;
}

export function fakeProvider(
  provider: ProviderOffer,
  options: {
    interrupt?: ControlOutcome<"turn">;
    answer?: ControlOutcome<"prompt">;
    readOnly?: boolean;
    startTurnOnSteer?: boolean;
    stableCheckpoint?: boolean;
    eventDrivenTurn?: boolean;
    failOnOverflow?: boolean;
  } = {},
): ProviderFixture {
  const interruptOutcome = options.interrupt ?? { status: "applied" };
  const answerOutcome = options.answer ?? { status: "applied" };
  const has = (capability: ProviderOffer["capabilities"][number]) =>
    provider.capabilities.includes(capability);
  const mode = has("own") ? "own" : "observe";
  const receipts = new Map<string, DeliveryReceipt>();
  const applied: ProviderEffect[] = [];
  let releases = 0;
  let activeTurn: string | null = null;
  let pendingPrompt: string | null = null;
  let currentCheckpoint = checkpoint;
  let nextWrite: (() => Promise<void>) | undefined;
  let closeResult: CloseOutcome = closed;

  function bind(
    spec: Pick<StartSpec, "session" | "run" | "afterSeq">,
    sessionMode: "own" | "observe",
    fencingToken: string,
    paste?: ObserveSpec["paste"],
  ) {
    const { session, run, afterSeq } = spec;
    const stream = fakeEventStream(bufferCapacity, options.failOnOverflow);
    activeTurn = null;
    let seq = afterSeq;
    let releaseResult: Promise<CloseOutcome> | undefined;
    let exiting = false;
    const envelope = {
      v: 1,
      session,
      run,
      at: 1,
      source: sessionMode === "own" ? "provider" : "observed",
    } as const;
    const matchesFence = (expected: RunFence) =>
      expected.run === run && expected.fencing_token === fencingToken;
    const isClosed = () => releaseResult !== undefined || exiting;
    const yieldBeforeWrite = () => {
      const pause = nextWrite;
      nextWrite = undefined;
      return pause?.();
    };

    const script = {
      async sendEvent(index: number) {
        if (isClosed()) return;
        if (index === 1 && options.eventDrivenTurn) {
          activeTurn = turn;
          await stream.emit({
            ...envelope,
            turn,
            seq: ++seq,
            kind: "turn.started",
            body: {},
          });
          return;
        }
        await stream.emit({
          ...envelope,
          turn: activeTurn,
          seq: ++seq,
          kind: "context",
          body: { data: { index } },
        });
      },
      async processExit() {
        if (isClosed()) return;
        exiting = true;
        await stream.emit({
          ...envelope,
          turn: null,
          seq: ++seq,
          kind: "session.ended",
          body: { reason: "process-exited" },
        });
        stream.end();
      },
      async streamDefect(error: Error) {
        exiting = true;
        stream.end(
          options.stableCheckpoint
            ? new Error("Adapter stream failed", { cause: error })
            : error,
        );
      },
      waitForBackpressure: stream.waitForBackpressure,
    };

    const operations = {
      events: stream.events,
      async steer(request): Promise<DeliveryOutcome> {
        if (isClosed()) return closed;
        if (sessionMode === "observe" && !paste)
          return { status: "unsupported", requires: "paste-target" };
        const pause = yieldBeforeWrite();
        if (pause) await pause;
        if (isClosed()) return closed;
        if (paste && request.expected.pane_instance !== paste.pane_instance)
          return stale({
            kind: "terminal",
            pane_instance: paste.pane_instance,
          });
        if (
          !matchesFence(request.expected) ||
          request.expected.turn !== activeTurn
        )
          return stale({ kind: "turn", turn: activeTurn });
        const existing =
          sessionMode === "own" ? receipts.get(request.delivery_id) : undefined;
        if (existing) return { status: "duplicate", receipt: existing };
        if (
          activeTurn !== null &&
          (sessionMode === "observe" || !has("steer-mid-turn"))
        )
          return { status: "unsupported", requires: "steer-mid-turn" };
        applied.push("steer");
        if (options.startTurnOnSteer) activeTurn = turn;
        if (sessionMode === "observe" || !has("receipts")) return bestEffort;
        const receipt = { delivery_id: request.delivery_id };
        receipts.set(request.delivery_id, receipt);
        await stream.emit({
          ...envelope,
          turn: activeTurn,
          seq: ++seq,
          kind: "receipt",
          body: receipt,
        });
        return { status: "accepted", receipt };
      },
      async interrupt(request): Promise<ControlOutcome<"turn">> {
        if (isClosed()) return closed;
        if (sessionMode !== "own")
          return { status: "unsupported", requires: "owned-session" };
        if (!has("interrupt"))
          return { status: "unsupported", requires: "interrupt" };
        const pause = yieldBeforeWrite();
        if (pause) await pause;
        if (isClosed()) return closed;
        if (
          !matchesFence(request.expected) ||
          request.expected.turn !== activeTurn
        )
          return stale({ kind: "turn", turn: activeTurn });
        applied.push("interrupt");
        return interruptOutcome;
      },
      async answer(request): Promise<ControlOutcome<"prompt">> {
        if (isClosed()) return closed;
        if (sessionMode !== "own")
          return { status: "unsupported", requires: "owned-session" };
        if (!has("prompts"))
          return { status: "unsupported", requires: "prompts" };
        const pause = yieldBeforeWrite();
        if (pause) await pause;
        if (isClosed()) return closed;
        if (
          !matchesFence(request.expected) ||
          request.expected.prompt_id !== pendingPrompt
        )
          return stale({ kind: "prompt", run, prompt_id: pendingPrompt });
        applied.push("answer");
        return answerOutcome;
      },
      close(): Promise<CloseOutcome> {
        if (!releaseResult) {
          releases++;
          releaseResult = stream.discard().then(() => closeResult);
        }
        return releaseResult;
      },
    } satisfies Omit<ObservedSession, "mode">;
    return { operations, script };
  }

  let currentScript: ReturnType<typeof bind>["script"];
  function owned(spec: StartSpec) {
    const { operations, script } = bind(spec, "own", spec.fencing_token);
    currentScript = script;
    const session = {
      ...operations,
      mode: "own",
      getCheckpoint: () => currentCheckpoint,
      recoveredReceipts: [...receipts.values()],
    } satisfies OwnedSession;
    return { status: "opened", session } as const;
  }

  const adapter = {
    provider,
    async observe(spec) {
      const { operations, script } = bind(
        spec,
        "observe",
        spec.paste?.fencing_token ?? fence,
        spec.paste,
      );
      currentScript = script;
      return { status: "opened", session: { ...operations, mode: "observe" } };
    },
    async start(spec) {
      return has("own")
        ? owned(spec)
        : { status: "unsupported", requires: "own" };
    },
    async resume(spec) {
      if (!has("resume")) return { status: "unsupported", requires: "resume" };
      if (spec.checkpoint !== currentCheckpoint)
        return {
          status: "refused",
          code: "CHECKPOINT_MISSING",
          message: "Checkpoint was not found",
        };
      return owned(spec);
    },
  } satisfies ProviderAdapter;

  const start = { cwd: "/workspace", fencing_token: fence };
  const expected = { run: scope.run, fencing_token: fence };
  return {
    adapter,
    mode,
    scope,
    steer: {
      delivery_id: "delivery-1",
      expected: {
        ...expected,
        turn: null,
        ...(mode === "observe" ? { pane_instance: pane } : {}),
      },
      authors: [author],
      input: [{ type: "text", text: "hello" }],
    },
    interrupt: { expected: { ...expected, turn } },
    answer: {
      expected: { ...expected, prompt_id: prompt },
      by: author,
      answer: true,
    },
    orderedEvents: [
      { kind: "context", body: { data: { index: 0 } } },
      options.eventDrivenTurn
        ? { kind: "turn.started", body: {} }
        : { kind: "context", body: { data: { index: 1 } } },
    ],
    nonReceiptDelivery:
      options.readOnly || options.startTurnOnSteer
        ? { status: "unsupported" }
        : bestEffort,
    interruptOutcome,
    answerOutcome,
    bufferCapacity,
    open: (position) =>
      mode === "own"
        ? adapter.start({ ...position, ...start })
        : adapter.observe({
            ...position,
            transcript: "/transcript",
            paste: options.readOnly
              ? undefined
              : { pane_instance: pane, fencing_token: fence },
          }),
    resumeSpec: (saved) => ({
      ...scope,
      ...start,
      checkpoint: saved,
      run: 2,
      fencing_token: "fence-2",
      afterSeq: 20,
    }),
    advanceCheckpoint: options.stableCheckpoint
      ? undefined
      : async () => {
          currentCheckpoint = "updated-checkpoint";
          return currentCheckpoint;
        },
    sendEvent: (index) => currentScript.sendEvent(index),
    processExit: () => currentScript.processExit(),
    streamDefect: (error) => currentScript.streamDefect(error),
    backpressure: options.failOnOverflow
      ? { kind: "fail" }
      : { kind: "block", wait: () => currentScript.waitForBackpressure() },
    async atActiveTurn(run) {
      if (options.readOnly) throw new Error("No controlled turn");
      if (options.eventDrivenTurn) await currentScript.sendEvent(1);
      else activeTurn = turn;
      try {
        return await run();
      } finally {
        activeTurn = null;
      }
    },
    async atPendingPrompt(run) {
      pendingPrompt = prompt;
      try {
        return await run();
      } finally {
        pendingPrompt = null;
      }
    },
    pauseBeforeWrite: options.stableCheckpoint
      ? undefined
      : () => {
          const entered = Promise.withResolvers<void>();
          const release = Promise.withResolvers<void>();
          nextWrite = () => {
            entered.resolve();
            return release.promise;
          };
          return { entered: entered.promise, release: release.resolve };
        },
    failClose() {
      closeResult = closeFailure;
      return closeFailure;
    },
    effects: () => [...applied],
    releases: () => releases,
  };
}
