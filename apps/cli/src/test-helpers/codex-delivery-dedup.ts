import { expect } from "bun:test";
import { deliveryTimeoutMsFor } from "../tmuxPaste.js";
import { pollUntil } from "./pollUntil.js";

type DeliveryRow = { _id: string; content: string };
type BatchFixture = {
  state: { menu: string | null };
  hooks: { turnStart: (() => Promise<unknown>) | undefined };
  deps: {
    appServerConversations: Map<string, string>;
    messagesInFlight: ReadonlyMap<string, unknown>;
    injectedMessageTs: ReadonlyMap<
      string,
      { confirmed: boolean; pasted: boolean }
    >;
    messageRetryTimers: ReadonlySet<string>;
  };
  timers: Array<{ fn: () => unknown; ms: number }>;
  events: string[];
  bodies: string[];
  statuses: Array<{
    messageId: string;
    status: string;
    pasteVerified?: boolean;
  }>;
  scan(rows: DeliveryRow[]): Promise<void>;
};

export async function assertCodexDeliveryDedup(
  f: BatchFixture,
  late: boolean,
): Promise<void> {
  f.state.menu = null;
  f.deps.appServerConversations.set("conv", "codex-thread");
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let turns = 0;
  f.hooks.turnStart = async () => {
    turns++;
    started.resolve();
    if (late) await finish.promise;
    throw new Error("Codex turn/start RPC timed out");
  };
  const row = { _id: "update", content: "continue" };
  const first = f.scan([row]);
  await started.promise;

  if (late) {
    const watchdog = f.timers.find(
      ({ ms }) => ms === deliveryTimeoutMsFor(row.content, undefined, 180_000),
    );
    if (!watchdog) throw new Error("Expected the delivery watchdog");
    await watchdog.fn();
    await first;
    const recheck = f.timers.find(({ ms }) => ms === 1000);
    if (!recheck) throw new Error("Expected the watchdog retry timer");
    await recheck.fn();
    expect(f.deps.messagesInFlight.has(row._id)).toBe(true);
    finish.resolve();
    await pollUntil(
      () => !f.deps.messagesInFlight.has(row._id),
      "late app-server attempt releases its slot",
    );
  }
  await first;

  expect(f.deps.injectedMessageTs.get(row._id)).toMatchObject({
    confirmed: false,
    pasted: true,
  });
  expect(f.deps.messageRetryTimers.size).toBe(0);
  expect(f.timers.filter(({ ms }) => ms === 1000)).toHaveLength(late ? 1 : 0);
  expect(f.events).toEqual(late ? ["retry:update"] : []);

  await f.scan([row]);
  expect(turns).toBe(1);
  expect(f.bodies).toEqual([]);
  expect(f.deps.injectedMessageTs.get(row._id)?.confirmed).toBe(true);
  expect(f.deps.messageRetryTimers.size).toBe(0);
  expect(f.statuses.at(-1)).toEqual({
    messageId: row._id,
    status: "injected",
    pasteVerified: true,
  });
}
