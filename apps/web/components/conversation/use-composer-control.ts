import { useInboxStore } from "../../store/inboxStore";
import type {
  ComposerControlCommandKey as CommandKey,
  ComposerObservation as Observation,
  ComposerOperation as Operations,
  ComposerOutcome as Outcome,
  ComposerRetry as Retry,
} from "../../store/steer-composer-state";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import {
  composerControlModel,
  selectComposerControl,
  type ComposerControlCommand,
  type ComposerControlFlag,
  type ComposerPayload,
  type SendState,
  type TurnExpectation,
} from "./composer-control-model";

type SendKind = "send" | "queue" | "suggest";
type ControlCommand = Exclude<ComposerControlCommand, ComposerPayload>;
const empty: Operations = { pending: new Map(), retries: [] };
const operations = () => useInboxStore.getState().composerOperations;

function update(id: string, apply: (record: Operations) => Operations) {
  useInboxStore
    .getState()
    .updateComposerOperation(id, apply(operations()[id] ?? empty));
}

function claim(
  id: string,
  observation: Observation,
  key: CommandKey,
  receipt?: Observation,
) {
  const record = operations()[id] ?? empty;
  const outcome =
    record.outcome?.observation === observation
      ? record.outcome
      : { observation, completed: new Set<CommandKey>() };
  if (
    record.observation !== observation ||
    (key === "submit"
      ? record.pending.has(key)
      : record.pending.get(key) === observation) ||
    outcome.completed.has(key)
  )
    return false;
  update(id, (current) => ({
    ...current,
    pending: new Map(current.pending).set(key, receipt ?? observation),
    outcome: {
      ...outcome,
      ...(key === "submit" ? { send: undefined } : { controlError: undefined }),
    },
  }));
  return true;
}

function settle(
  id: string,
  observation: Observation,
  key: CommandKey,
  change: (outcome: Outcome) => Outcome,
  token = observation,
) {
  update(id, (current) => {
    if (current.pending.get(key) !== token) return current;
    const pending = new Map(current.pending);
    pending.delete(key);
    return {
      ...current,
      pending,
      outcome:
        current.observation === observation &&
        current.outcome?.observation === observation
          ? change(current.outcome)
          : current.outcome,
    };
  });
}

export function useComposerControl(
  conversationId: string,
  flag?: ComposerControlFlag,
) {
  const shared = selectComposerControl(flag, conversationId);
  const scopedId = shared ? conversationId : null;
  const record = useInboxStore((state) =>
    scopedId ? (state.composerOperations[scopedId] ?? empty) : empty,
  );
  const facts = shared?.facts;
  const observed = facts
    ? JSON.stringify([
        facts.viewerId,
        facts.turn,
        facts.expected?.address,
        facts.expected?.batonToken,
        facts.driver?.id,
        facts.role,
        facts.driveRequested,
        facts.takeoverPending,
        facts.canSteer,
        facts.canTakeOver,
      ])
    : null;
  const receiptKey = facts
    ? JSON.stringify([
        observed,
        facts.sendState?.kind,
        facts.sendState?.kind === "waiting-for-driver"
          ? facts.sendState.driver
          : null,
      ])
    : null;
  useWatchEffect(() => {
    const current = operations()[conversationId];
    if (observed === null || receiptKey === null) {
      if (current?.observation || current?.receipt)
        update(conversationId, (record) => ({
          ...record,
          observation: undefined,
          receipt: undefined,
        }));
      return;
    }
    if (
      current?.observation?.key === observed &&
      current.receipt?.key === receiptKey
    )
      return;
    update(conversationId, (record) => ({
      ...record,
      observation:
        record.observation?.key === observed
          ? record.observation
          : { key: observed },
      receipt:
        record.receipt?.key === receiptKey
          ? record.receipt
          : { key: receiptKey },
    }));
  }, [conversationId, observed, receiptKey]);
  if (!shared) return null;

  const { baton } = shared;
  const currentFacts = shared.facts;
  const observation =
    record.observation?.key === observed ? record.observation : undefined;
  const outcome =
    record.outcome?.observation === observation ? record.outcome : undefined;
  const receipt =
    record.receipt?.key === receiptKey ? record.receipt : undefined;
  const localSend =
    outcome?.send?.receipt === receipt ? outcome?.send?.state : undefined;
  const view = composerControlModel({
    ...currentFacts,
    sendState:
      receipt && record.pending.get("submit") === receipt
        ? { kind: "submitting" }
        : (localSend ?? currentFacts.sendState),
  });
  const expected: TurnExpectation = currentFacts.expected ?? {
    kind: "turn",
    turn: currentFacts.turn,
  };

  function begin(kind: SendKind, retry?: Retry) {
    if (
      !observation ||
      !receipt ||
      !claim(conversationId, observation, "submit", receipt)
    )
      return null;
    return async (
      prepare: () => ComposerPayload | Promise<ComposerPayload>,
      restore: (payload: ComposerPayload) => boolean,
      fallback?: ComposerPayload,
    ) => {
      let payload = fallback;
      let sendState: SendState | undefined;
      let attempted = retry?.command;
      try {
        payload = await prepare();
        const content = currentFacts.live
          ? { ...payload, clientId: payload.clientId ?? crypto.randomUUID() }
          : payload;
        attempted ??=
          kind === "send"
            ? { ...content, kind, expected }
            : { ...content, kind };
        const result = await baton.run(attempted);
        if (result === "accepted") {
          if (retry) dismissRetry(retry);
          if (currentFacts.live && !currentFacts.sendState)
            sendState = { kind: "saved" };
          return true;
        }
        sendState = { kind: result === "stale" ? "stale" : "refused" };
        if (retry) {
          update(conversationId, (current) => ({
            ...current,
            retries: current.retries.map((row) =>
              row.id === retry.id ? { id: row.id, payload: row.payload } : row,
            ),
          }));
        } else if (!restore(payload)) addRetry(payload);
      } catch {
        sendState = { kind: "in-doubt" };
        if (payload && !retry)
          addRetry(payload, currentFacts.live ? attempted : undefined);
      } finally {
        settle(
          conversationId,
          observation,
          "submit",
          (current) => ({
            ...current,
            send: sendState ? { receipt, state: sendState } : undefined,
          }),
          receipt,
        );
      }
      return false;
    };
  }

  function addRetry(
    payload: ComposerPayload,
    command?: ComposerControlCommand,
  ) {
    update(conversationId, (current) => ({
      ...current,
      retries: [
        ...current.retries,
        { id: crypto.randomUUID(), payload, command },
      ],
    }));
  }

  function dismissRetry(retry: Retry) {
    update(conversationId, (current) => ({
      ...current,
      retries: current.retries.filter((row) => row.id !== retry.id),
    }));
  }

  function retryDraft(retry: Retry) {
    const kind = view.canQueue
      ? "queue"
      : view.send === "suggest"
        ? "suggest"
        : null;
    const current = operations()[conversationId];
    if (!kind || !current?.retries.some((row) => row.id === retry.id)) return;
    const complete = begin(kind, retry);
    if (complete)
      void complete(
        () => retry.payload,
        () => true,
      );
  }

  async function act(command: ControlCommand) {
    const key = command.kind;
    if (currentFacts.live && key !== "interrupt") {
      if (!observation) return;
      let controlError: Outcome["controlError"];
      try {
        if ((await baton.run(command)) !== "accepted") controlError = "refused";
      } catch {
        controlError = "in-doubt";
      }
      if (controlError) {
        update(conversationId, (current) => {
          const observed = current.observation;
          if (!observed) return current;
          const outcome =
            current.outcome?.observation === observed
              ? current.outcome
              : { observation: observed, completed: new Set<CommandKey>() };
          return { ...current, outcome: { ...outcome, controlError } };
        });
      }
      return;
    }
    if (!observation || !claim(conversationId, observation, key)) return;
    let error: Outcome["controlError"];
    try {
      if ((await baton.run(command)) !== "accepted") error = "refused";
    } catch {
      error = "in-doubt";
    } finally {
      settle(conversationId, observation, key, (current) => ({
        ...current,
        controlError: error,
        completed: error
          ? current.completed
          : new Set([...current.completed, key]),
      }));
    }
  }

  const pendingControl = (key: ControlCommand["kind"]) =>
    !!observation && record.pending.get(key) === observation;

  return {
    ...view,
    submitting: view.submitting || record.pending.has("submit"),
    facts: currentFacts,
    expected,
    begin,
    isSubmitting: () =>
      view.submitting || operations()[conversationId]?.pending.has("submit"),
    act,
    retryDraft,
    dismissRetry,
    retries: record.retries,
    controlError: outcome?.controlError,
    request:
      view.request && outcome?.completed.has("ask")
        ? ("requested" as const)
        : view.request,
    askPending: pendingControl("ask"),
    takeoverPending:
      pendingControl("takeover") || !!outcome?.completed.has("takeover"),
    interruptPending:
      pendingControl("interrupt") || !!outcome?.completed.has("interrupt"),
    cancelPending:
      pendingControl("cancel-takeover") ||
      !!outcome?.completed.has("cancel-takeover"),
  };
}

export type ComposerControl = NonNullable<
  ReturnType<typeof useComposerControl>
>;
