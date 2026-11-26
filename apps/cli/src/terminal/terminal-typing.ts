import { setTimeout as wait } from "node:timers/promises";
import {
  hexToBytes,
  isValidPaneTarget,
  PANE_HEARTBEAT_MS,
  PANE_INPUT_POLL_MS,
  PANE_MAX_PENDING_INPUT_BYTES,
} from "@codecast/daemon/terminalStream";
import { physicalPaneKey, type TypingPane } from "./tmux-typing-pane.js";
import { countingSemaphore } from "../semaphore.js";

export type TypingBinding = {
  conversation_id: string;
  tmux_session: string;
  agent_started_at: number;
};
type MachinePane = Pick<
  TypingBinding,
  "conversation_id" | "agent_started_at"
> & {
  pane_instance: number;
};
type Control = {
  pane_instance: number;
  sequence: number;
  token: number | null;
};
type Ack = Pick<Control, "sequence" | "token">;
export type TerminalTypingTransport = {
  catalog(): Promise<TypingBinding[]>;
  report(
    args: MachinePane & {
      observation: "started" | "ended";
      watch_pane_instance?: string;
    },
  ): Promise<
    | { status: "ok"; last_pane_instance: number }
    | { status: "disabled" | "stale" }
  >;
  poll(args: MachinePane & { ack?: Ack }): Promise<
    | {
        status: "ok";
        control: Control;
        input?: { pane_instance: number; token: number; data: string };
      }
    | { status: "disabled" | "stale" }
  >;
};

type Dependencies = TerminalTypingTransport & {
  resolve(target: string): Promise<TypingPane | null>;
  write(
    target: string,
    pane: TypingPane,
    bytes: readonly number[],
  ): Promise<boolean>;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<unknown>;
};
type OpenPane = { machine: MachinePane; key: string };

const pause = (ms: number, signal: AbortSignal) =>
  wait(ms, undefined, { signal, ref: false }).catch(() => {});
const counter = (value: number) => Number.isSafeInteger(value) && value > 0;
const nextRetryDelay = (ms: number) => Math.min(ms * 2, 30_000);

export function startTerminalTyping(enabled: boolean, deps: Dependencies) {
  if (!enabled) return async () => {};
  const stop = new AbortController();
  const sleep = deps.sleep ?? pause;
  const now = deps.now ?? (() => performance.now());
  const probes = countingSemaphore(8);
  const resolve = (target: string, signal: AbortSignal, front = false) =>
    probes.run(
      () => (signal.aborted ? Promise.resolve(null) : deps.resolve(target)),
      { front },
    );
  const paneKeys = new Set<string>();
  const trackers = new Map<
    string,
    {
      binding: TypingBinding;
      stop: AbortController;
      running: Promise<void>;
    }
  >();

  const halt = () => {
    stop.abort();
    for (const tracker of trackers.values()) tracker.stop.abort();
  };

  async function end(open: OpenPane) {
    try {
      await deps.report({ ...open.machine, observation: "ended" });
    } catch {
    } finally {
      paneKeys.delete(open.key);
    }
  }

  async function track(binding: TypingBinding, signal: AbortSignal) {
    const { tmux_session: target, ...machine } = binding;
    let open: OpenPane | undefined;
    let control: Control | undefined;
    let acknowledged = false;
    let nextIdentity = 0;
    let retryDelay = PANE_HEARTBEAT_MS;
    try {
      while (!signal.aborted) {
        let delay = PANE_HEARTBEAT_MS;
        let failed = false;
        try {
          if (!open || now() >= nextIdentity) {
            nextIdentity = now() + PANE_HEARTBEAT_MS;
            const pane = await resolve(target, signal);
            if (signal.aborted) break;
            const key = pane && physicalPaneKey(pane);
            if (open && key !== open.key) {
              await end(open);
              open = undefined;
              control = undefined;
              acknowledged = false;
            }
            if (!open && pane && key && !paneKeys.has(key) && !signal.aborted) {
              paneKeys.add(key);
              try {
                const opened = await deps.report({
                  ...machine,
                  pane_instance: 0,
                  observation: "started",
                  watch_pane_instance: pane.watchIdentity,
                });
                if (opened.status === "disabled") {
                  halt();
                  return;
                }
                if (
                  opened.status === "ok" &&
                  counter(opened.last_pane_instance)
                )
                  open = {
                    key,
                    machine: {
                      ...machine,
                      pane_instance: opened.last_pane_instance,
                    },
                  };
                else failed = true;
              } finally {
                if (!open) paneKeys.delete(key);
              }
            }
          }
          if (open && !signal.aborted) {
            const ack =
              acknowledged && control
                ? { sequence: control.sequence, token: control.token }
                : undefined;
            const reply = await deps.poll({
              ...open.machine,
              ...(ack && { ack }),
            });
            if (signal.aborted) return;
            if (reply.status === "disabled") {
              halt();
              return;
            }
            if (reply.status === "stale") {
              acknowledged = false;
              if (ack) delay = PANE_INPUT_POLL_MS;
              else {
                failed = true;
                await end(open);
                open = undefined;
                control = undefined;
              }
            } else if (reply.status === "ok") {
              const next = reply.control;
              if (
                next.pane_instance === open.machine.pane_instance &&
                counter(next.sequence) &&
                (next.token === null || counter(next.token)) &&
                (!control ||
                  next.sequence > control.sequence ||
                  (next.sequence === control.sequence &&
                    next.token === control.token))
              ) {
                control = next;
                acknowledged = true;
                if (next.token !== null || ack?.sequence !== next.sequence)
                  delay = PANE_INPUT_POLL_MS;
                const input = reply.input;
                if (
                  input &&
                  next.token !== null &&
                  ack?.sequence === next.sequence &&
                  ack.token === next.token &&
                  input.pane_instance === next.pane_instance &&
                  input.token === next.token &&
                  input.data.length <= PANE_MAX_PENDING_INPUT_BYTES * 2
                ) {
                  const bytes = hexToBytes(input.data);
                  if (bytes?.length) {
                    const actual = await resolve(target, signal, true);
                    if (signal.aborted) return;
                    const written =
                      actual &&
                      physicalPaneKey(actual) === open.key &&
                      (await deps.write(target, actual, bytes));
                    if (!written) {
                      await end(open);
                      open = undefined;
                      control = undefined;
                      acknowledged = false;
                    }
                  }
                }
              }
            }
          }
        } catch {
          failed = true;
        }
        if (failed) {
          delay = retryDelay;
          retryDelay = nextRetryDelay(retryDelay);
        } else retryDelay = PANE_HEARTBEAT_MS;
        if (!signal.aborted) await sleep(delay, signal);
      }
    } finally {
      if (open) await end(open);
    }
  }

  const discover = async () => {
    let retryDelay = PANE_HEARTBEAT_MS;
    while (!stop.signal.aborted) {
      let delay = PANE_HEARTBEAT_MS;
      try {
        const rows = await deps.catalog();
        if (stop.signal.aborted) break;
        const wanted = new Map(
          rows
            .filter(
              ({ tmux_session }) =>
                isValidPaneTarget(tmux_session) &&
                !tmux_session.startsWith("%"),
            )
            .map((row) => [row.conversation_id, row]),
        );
        const retired: Promise<void>[] = [];
        for (const [id, current] of trackers) {
          const next = wanted.get(id);
          if (
            next?.tmux_session === current.binding.tmux_session &&
            next.agent_started_at === current.binding.agent_started_at
          )
            continue;
          current.stop.abort();
          retired.push(current.running);
          trackers.delete(id);
        }
        await Promise.all(retired);
        for (const [id, binding] of wanted) {
          if (stop.signal.aborted) break;
          if (trackers.has(id)) continue;
          const controller = new AbortController();
          const running = track(binding, controller.signal);
          trackers.set(id, { binding, stop: controller, running });
        }
        retryDelay = PANE_HEARTBEAT_MS;
      } catch {
        delay = retryDelay;
        retryDelay = nextRetryDelay(retryDelay);
      }
      if (!stop.signal.aborted) await sleep(delay, stop.signal);
    }
  };
  const running = discover();
  return async () => {
    halt();
    await running;
    await Promise.all([...trackers.values()].map((tracker) => tracker.running));
  };
}
