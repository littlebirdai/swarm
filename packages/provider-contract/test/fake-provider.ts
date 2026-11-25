import type {
  CloseOutcome,
  ControlOutcome,
  DeliveryOutcome,
  DeliveryReceipt,
  ObservedSession,
  ObserveSpec,
  OwnedSession,
  ProviderAdapter,
  ProviderEvent,
  ProviderOffer,
  SessionPosition,
  StartSpec,
} from "../src";
import type { ProviderFixture } from "./conformance";

const scope = { session: "session-1", run: 1, afterSeq: 10 };
const fence = "fence-1";
const turn = "turn-1";
const prompt = "prompt-1";
const pane = "pane-1";
const checkpoint = "checkpoint";
const author = { kind: "person", id: "owner" } as const;

export function fakeProvider(
  provider: ProviderOffer,
  interruptOutcome: ControlOutcome = { status: "applied" },
): ProviderFixture {
  const has = (capability: ProviderOffer["capabilities"][number]) =>
    provider.capabilities.includes(capability);
  const mode = has("own") ? "own" : "observe";
  const receipts = new Map<string, DeliveryReceipt>();
  const applied: string[] = [];
  let releases = 0;
  let activeTurn: string | null = null;
  let currentScope = scope;
  let emit: (event: ProviderEvent) => void = () => {
    throw new Error("Open the provider before feeding events");
  };

  function bind(
    spec: Pick<StartSpec, "session" | "run" | "afterSeq">,
    sessionMode: "own" | "observe",
    fencingToken: string,
    paste?: ObserveSpec["paste"],
  ) {
    const { session, run, afterSeq } = spec;
    currentScope = { session, run, afterSeq };
    const buffered: ProviderEvent[] = [];
    let waiting: ((result: IteratorResult<ProviderEvent>) => void) | undefined;
    let closed = false;
    const done = { done: true, value: undefined } as const;
    const envelope = {
      v: 1,
      session,
      run,
      at: 1,
      source: sessionMode === "own" ? "provider" : "observed",
      turn: null,
    } as const;
    emit = (event) => {
      if (closed) return;
      if (waiting) {
        waiting({ done: false, value: event });
        waiting = undefined;
      } else {
        buffered.push(event);
      }
    };
    const events: AsyncIterable<ProviderEvent> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (closed) return done;
            const value = buffered.shift();
            if (value) return { done: false, value };
            const next = Promise.withResolvers<IteratorResult<ProviderEvent>>();
            waiting = next.resolve;
            return next.promise;
          },
        };
      },
    };
    const matches = (expected: SessionPosition) =>
      expected.run === run &&
      expected.turn === activeTurn &&
      expected.fencing_token === fencingToken;
    const observed = () => ({ run, turn: activeTurn });

    return {
      events,
      async steer(request): Promise<DeliveryOutcome> {
        if (closed) return { status: "closed" };
        if (sessionMode === "observe" && !paste)
          return { status: "unsupported", requires: "paste-target" };
        if (
          activeTurn !== null &&
          (sessionMode === "observe" || !has("steer-mid-turn"))
        )
          return { status: "unsupported", requires: "steer-mid-turn" };
        if (paste && request.expected.pane_instance !== paste.pane_instance)
          return {
            status: "stale",
            observed: { ...observed(), pane_instance: paste.pane_instance },
          };
        if (!matches(request.expected))
          return { status: "stale", observed: observed() };
        const existing =
          sessionMode === "own" ? receipts.get(request.delivery_id) : undefined;
        if (existing) return { status: "duplicate", receipt: existing };
        applied.push("steer");
        if (sessionMode === "observe" || !has("receipts"))
          return {
            status: "in-doubt",
            reason: sessionMode === "observe" ? "best-effort" : "unknown",
          };
        const receipt = { delivery_id: request.delivery_id };
        receipts.set(request.delivery_id, receipt);
        emit({
          ...envelope,
          seq: afterSeq + 1,
          kind: "receipt",
          body: receipt,
        });
        return { status: "accepted", receipt };
      },
      async interrupt(request): Promise<ControlOutcome> {
        if (closed) return { status: "closed" };
        if (sessionMode !== "own")
          return { status: "unsupported", requires: "owned-session" };
        if (!has("interrupt"))
          return { status: "unsupported", requires: "interrupt" };
        if (!matches(request.expected))
          return { status: "stale", observed: observed() };
        applied.push("interrupt");
        return interruptOutcome;
      },
      async answer(request): Promise<ControlOutcome> {
        if (closed) return { status: "closed" };
        if (sessionMode !== "own")
          return { status: "unsupported", requires: "owned-session" };
        if (!has("prompts"))
          return { status: "unsupported", requires: "prompts" };
        if (!matches(request.expected) || request.expected.prompt_id !== prompt)
          return {
            status: "stale",
            observed: { ...observed(), prompt_id: prompt },
          };
        applied.push("answer");
        return { status: "applied" };
      },
      async close(): Promise<CloseOutcome> {
        if (!closed) {
          closed = true;
          releases++;
          buffered.length = 0;
          waiting?.(done);
          waiting = undefined;
        }
        return { status: "closed" };
      },
    } satisfies Omit<ObservedSession, "mode">;
  }

  function owned(spec: StartSpec) {
    const session = {
      ...bind(spec, "own", spec.fencing_token),
      mode: "own",
      checkpoint,
      recoveredReceipts: [...receipts.values()],
    } satisfies OwnedSession;
    return { status: "opened", session } as const;
  }

  const adapter = {
    provider,
    async observe(spec) {
      const session = {
        ...bind(
          spec,
          "observe",
          spec.paste?.fencing_token ?? fence,
          spec.paste,
        ),
        mode: "observe",
      } satisfies ObservedSession;
      return { status: "opened", session };
    },
    async start(spec) {
      return has("own")
        ? owned(spec)
        : { status: "unsupported", requires: "own" };
    },
    async resume(spec) {
      return has("resume")
        ? owned(spec)
        : { status: "unsupported", requires: "resume" };
    },
  } satisfies ProviderAdapter;

  const start = { ...scope, cwd: "/workspace", fencing_token: fence };
  const expected = { run: scope.run, turn: null, fencing_token: fence };
  const active = { ...expected, turn };
  const fixture: ProviderFixture = {
    adapter,
    mode,
    steer: {
      delivery_id: "delivery-1",
      expected: {
        ...expected,
        ...(mode === "observe" ? { pane_instance: pane } : {}),
      },
      authors: [author],
      input: [{ type: "text", text: "hello" }],
    },
    interrupt: { expected: active },
    answer: {
      expected: { ...active, prompt_id: prompt },
      by: author,
      answer: true,
    },
    get orderedEvents(): ProviderFixture["orderedEvents"] {
      const eventScope = {
        v: 1,
        session: currentScope.session,
        run: currentScope.run,
        at: 2,
        source: mode === "own" ? "provider" : "observed",
        turn,
      } as const;
      return [
        {
          ...eventScope,
          kind: "turn.started",
          seq: currentScope.afterSeq + 2,
          body: {},
        },
        {
          ...eventScope,
          kind: "message.assistant",
          seq: currentScope.afterSeq + 3,
          body: { message_id: "answer-1", text: "hello" },
        },
      ];
    },
    nonReceiptDelivery: mode === "own" ? "unknown" : "best-effort",
    open: () =>
      mode === "own"
        ? adapter.start(start)
        : adapter.observe({
            ...scope,
            transcript: "/transcript",
            paste: { pane_instance: pane, fencing_token: fence },
          }),
    resumeSpec: (saved) => ({
      ...start,
      checkpoint: saved,
      run: 2,
      fencing_token: "fence-2",
      afterSeq: 20,
    }),
    async sendEvent(index) {
      emit(fixture.orderedEvents[index]);
    },
    async atActiveTurn(run) {
      activeTurn = turn;
      try {
        return await run();
      } finally {
        activeTurn = null;
      }
    },
    effects: () => [...applied],
    releases: () => releases,
  };
  return fixture;
}
