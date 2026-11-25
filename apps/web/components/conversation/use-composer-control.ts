import { useCallback, useSyncExternalStore } from "react";
import { createStore } from "zustand/vanilla";
import {
  composerControlModel,
  selectComposerControl,
  type ComposerControlCommand,
  type ComposerControlFlag,
  type ComposerPayload,
  type SendState,
} from "./composer-control-model";

type SendKind = "send" | "queue" | "suggest";
type ControlCommand = Exclude<ComposerControlCommand, ComposerPayload>;
type Retry = { id: number; payload: ComposerPayload };

type Operations = {
  pending: ReadonlySet<string>;
  completed: ReadonlySet<string>;
  retries: Retry[];
  sendState: SendState | null;
  controlError: "refused" | "in-doubt" | null;
};

const empty: Operations = {
  pending: new Set(),
  completed: new Set(),
  retries: [],
  sendState: null,
  controlError: null,
};
const operations = createStore<Record<string, Operations>>(() => ({}));
let retryId = 0;

function update(id: string, apply: (record: Operations) => Operations) {
  operations.setState((state) => ({ [id]: apply(state[id] ?? empty) }));
}

function claim(id: string, key: string) {
  const record = operations.getState()[id] ?? empty;
  if (record.pending.has(key) || record.completed.has(key)) return false;
  update(id, (current) => ({
    ...current,
    pending: new Set([...current.pending, key]),
    ...(key === "submit" ? { sendState: null } : { controlError: null }),
  }));
  return true;
}

function release(id: string, key: string, complete = false) {
  update(id, (current) => ({
    ...current,
    pending: new Set([...current.pending].filter((item) => item !== key)),
    completed: complete
      ? new Set(
          [...current.completed]
            .filter((item) => {
              const kind = item.split(":")[0];
              const currentKind = key.split(":")[0];
              return (
                kind !== currentKind &&
                !(currentKind === "takeover" && kind === "cancel-takeover") &&
                !(currentKind === "cancel-takeover" && kind === "takeover")
              );
            })
            .concat(key),
        )
      : current.completed,
  }));
}

export function useComposerControl(
  conversationId: string,
  flag?: ComposerControlFlag,
) {
  const shared = selectComposerControl(flag, conversationId);
  const scopedId = shared ? conversationId : null;
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!scopedId) return () => {};
      return operations.subscribe((next, prev) => {
        if (next[scopedId] !== prev[scopedId]) listener();
      });
    },
    [scopedId],
  );
  const snapshot = useCallback(
    () => (scopedId ? (operations.getState()[scopedId] ?? empty) : empty),
    [scopedId],
  );
  const record = useSyncExternalStore(subscribe, snapshot, snapshot);
  if (!shared) return null;

  const { facts, baton } = shared;
  const view = composerControlModel({
    ...facts,
    sendState: record.pending.has("submit")
      ? { kind: "submitting" }
      : (record.sendState ?? facts.sendState),
  });
  const expected = { kind: "turn", turn: facts.turn } as const;
  const askKey = `ask:${facts.role}:${facts.driveRequested}`;
  const takeoverKey = `takeover:${facts.turn}:${facts.driver?.id}`;
  const cancelKey = `cancel-takeover:${facts.turn}:${facts.driver?.id}`;

  function begin(kind: SendKind, retry?: Retry) {
    if (!claim(conversationId, "submit")) return null;
    return async (
      prepare: () => ComposerPayload | Promise<ComposerPayload>,
      restore: (payload: ComposerPayload) => boolean,
      fallback?: ComposerPayload,
    ) => {
      let payload = fallback;
      try {
        payload = await prepare();
        const command =
          kind === "send"
            ? ({ ...payload, kind, expected } as const)
            : ({ ...payload, kind } as const);
        const result = await baton.run(command);
        if (result === "accepted") {
          if (retry)
            update(conversationId, (current) => ({
              ...current,
              retries: current.retries.filter((row) => row.id !== retry.id),
            }));
          return true;
        }
        update(conversationId, (current) => ({
          ...current,
          sendState: { kind: result === "stale" ? "stale" : "refused" },
        }));
        if (!restore(payload)) addRetry(payload);
      } catch {
        update(conversationId, (current) => ({
          ...current,
          sendState: { kind: "in-doubt" },
        }));
        if (payload && !retry) addRetry(payload);
      } finally {
        release(conversationId, "submit");
      }
      return false;
    };
  }

  function addRetry(payload: ComposerPayload) {
    update(conversationId, (current) => ({
      ...current,
      retries: [...current.retries, { id: ++retryId, payload }],
    }));
  }

  function queueRetry(retry: Retry) {
    const record = operations.getState()[conversationId];
    if (!record?.retries.some((row) => row.id === retry.id)) return;
    const complete = begin("queue", retry);
    if (complete)
      void complete(
        () => retry.payload,
        () => true,
      );
  }

  async function act(command: ControlCommand) {
    const key =
      command.kind === "ask"
        ? askKey
        : command.kind === "takeover"
          ? takeoverKey
          : command.kind === "cancel-takeover"
            ? cancelKey
            : `interrupt:${facts.turn}`;
    if (!claim(conversationId, key)) return;
    let complete = false;
    try {
      complete = (await baton.run(command)) === "accepted";
      if (!complete)
        update(conversationId, (current) => ({
          ...current,
          controlError: "refused",
        }));
    } catch {
      update(conversationId, (current) => ({
        ...current,
        controlError: "in-doubt",
      }));
    } finally {
      release(conversationId, key, complete);
    }
  }

  return {
    ...view,
    facts,
    expected,
    begin,
    isSubmitting: () =>
      view.submitting ||
      operations.getState()[conversationId]?.pending.has("submit"),
    act,
    queueRetry,
    retries: record.retries,
    controlError: record.controlError,
    submitting: view.submitting || record.pending.has("submit"),
    request:
      view.request && record.completed.has(askKey)
        ? ("requested" as const)
        : view.request,
    askPending: record.pending.has(askKey),
    takeoverPending:
      record.pending.has(takeoverKey) || record.completed.has(takeoverKey),
    interruptPending:
      record.pending.has(`interrupt:${facts.turn}`) ||
      record.completed.has(`interrupt:${facts.turn}`),
    cancelPending:
      record.pending.has(cancelKey) || record.completed.has(cancelKey),
  };
}

export type ComposerControl = NonNullable<
  ReturnType<typeof useComposerControl>
>;
