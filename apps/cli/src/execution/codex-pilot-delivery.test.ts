import { expect, test } from "bun:test";
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { until } from "../../../../tests/codex-driver-parity/peers.js";
import { fixture, item, pending } from "./codex-owned-pilot-fixture.js";
import { FileExecutionOperationJournal } from "./local-journal.js";

async function finishTurn(f: ReturnType<typeof fixture>, turn: string) {
  await f.sendFrame({
    frame: {
      method: "turn/completed",
      params: {
        threadId: f.deliveryThread,
        turn: { id: turn, items: [], status: "completed" },
      },
    },
  });
  await until(
    () =>
      f.events.some(
        (event) => event.kind === "turn.ended" && event.turn === turn,
      ),
    "completed turn reaches the daemon",
  );
}

function turnStarts(f: ReturnType<typeof fixture>) {
  return f.deliveryRequests();
}

async function reportReceipt(
  f: ReturnType<typeof fixture>,
  index: number,
  beforeRpcReply = false,
) {
  await until(
    () => turnStarts(f).length === index,
    `Codex receives input ${index}`,
  );
  const call = turnStarts(f)[index - 1]!;
  expect(call.params?.clientUserMessageId).toBe(
    `codecast-delivery:delivery-${index}`,
  );
  if (beforeRpcReply) {
    await f.sendFrame({
      frame: {
        method: "turn/started",
        params: {
          threadId: f.deliveryThread,
          turn: { id: `actual-turn-${index}`, status: "inProgress" },
        },
      },
    });
  }
  await f.sendFrame({
    frame: {
      method: "item/completed",
      params: {
        threadId: f.deliveryThread,
        turnId: `actual-turn-${index}`,
        item: {
          type: "userMessage",
          id: `provider-item-${index}`,
          clientId: call.params?.clientUserMessageId,
          content: call.params?.input,
        },
      },
    },
  });
  await until(
    () =>
      f.events.some(
        (event) =>
          event.kind === "receipt" &&
          event.body.delivery_id === `delivery-${index}`,
      ),
    `the daemon appends receipt ${index}`,
  );
  if (beforeRpcReply) await f.sendFrame({ ackStart: true });
}

test("the pilot settles two identical messages with separate durable receipts", async () => {
  const f = fixture("pilot", true, "receipt-before-reply");
  const { deliveryReceipts } = new FileExecutionOperationJournal(
    f.journalDirectory,
  );
  const signal = new AbortController().signal;
  const work = [item(f.pilotRequest)];
  try {
    await f.runtime.processWorkUpdate(work);
    await deliveryReceipts.record(
      "pilot",
      f.deliveryThread,
      {
        delivery_id: "unrelated",
        provider_item_id: "other-item",
        turn: "other-turn",
      },
      signal,
    );
    const unrelated = readdirSync(f.journalDirectory).find((file) =>
      file.endsWith(".receipt"),
    )!;
    const unrelatedPath = join(f.journalDirectory, unrelated);
    writeFileSync(unrelatedPath, "invalid");
    f.enqueue(1);
    f.enqueue(2);

    const first = f.runtime.processWorkUpdate(work);
    await reportReceipt(f, 1, true);
    await first;
    await f.runtime.processWorkUpdate(work);
    expect(
      f.settlements
        .filter(({ outcome }) => outcome === "applied")
        .map(({ delivery_id }) => delivery_id),
    ).toEqual(["delivery-1"]);
    expect(f.runtime.coordinator.getActiveDelivery("pilot")).toBeUndefined();
    expect(turnStarts(f)).toHaveLength(1);
    rmSync(unrelatedPath);
    expect(
      await deliveryReceipts.read("pilot", f.deliveryThread, signal),
    ).toEqual([]);

    await finishTurn(f, "actual-turn-1");
    const second = f.runtime.processWorkUpdate(work);
    await reportReceipt(f, 2, true);
    await second;
    await f.runtime.processWorkUpdate(work);
    expect(
      f.settlements.flatMap((settlement) =>
        settlement.outcome === "applied" &&
        "resolution_evidence" in settlement &&
        typeof settlement.resolution_evidence === "string"
          ? [JSON.parse(settlement.resolution_evidence)]
          : [],
      ),
    ).toEqual([
      {
        delivery_id: "delivery-1",
        provider_item_id: "provider-item-1",
        turn: "actual-turn-1",
      },
      {
        delivery_id: "delivery-2",
        provider_item_id: "provider-item-2",
        turn: "actual-turn-2",
      },
    ]);
    expect(f.settlements.map(({ outcome }) => outcome)).toEqual([
      "applied",
      "applied",
    ]);
    expect(turnStarts(f).map(({ params }) => params?.input)).toEqual([
      [{ type: "text", text: "identical follow-up" }],
      [{ type: "text", text: "identical follow-up" }],
    ]);
    expect(f.runtime.coordinator.getActiveDelivery("pilot")).toBeUndefined();
    expect(
      await deliveryReceipts.read("pilot", f.deliveryThread, signal),
    ).toEqual([]);
  } finally {
    await f.dispose();
  }
});

test("a missing receipt holds the slot until the server settles that delivery", async () => {
  const f = fixture("pilot", true, "receipt");
  const work = [item(f.pilotRequest)];
  try {
    await f.runtime.processWorkUpdate(work);
    f.enqueue(1);
    f.enqueue(2);
    const deliveryActions = f.actions.length;
    await f.runtime.processWorkUpdate(work);
    expect(
      f.actions
        .slice(deliveryActions)
        .filter((action) => action === "edge:permits.next"),
    ).toHaveLength(1);
    expect(f.runtime.coordinator.getActiveDelivery("pilot")).toMatchObject({
      attemptId: "attempt-1",
      state: "ambiguous",
    });
    await until(() => f.settlements.length === 1, "server records ambiguity");
    expect(f.settlements[0]).toMatchObject({
      delivery_id: "delivery-1",
      outcome: "in_doubt",
    });
    await finishTurn(f, "actual-turn-1");
    await f.runtime.processWorkUpdate(work);
    f.staleReads(true);
    await f.runtime.processWorkUpdate(work);
    expect(f.runtime.coordinator.getActiveDelivery("pilot")?.attemptId).toBe(
      "attempt-1",
    );
    expect(turnStarts(f)).toHaveLength(1);
    f.staleReads(false);
    f.queue.shift();

    const next = f.runtime.processWorkUpdate(work);
    await reportReceipt(f, 2);
    await next;
    await f.runtime.processWorkUpdate(work);
    expect(
      f.settlements
        .filter(({ delivery_id }) => delivery_id === "delivery-1")
        .map(({ outcome }) => outcome),
    ).toEqual(["in_doubt"]);
    expect(
      f.settlements.filter(({ outcome }) => outcome === "applied"),
    ).toMatchObject([{ delivery_id: "delivery-2" }]);
    expect(f.runtime.coordinator.getActiveDelivery("pilot")).toBeUndefined();
  } finally {
    await f.dispose();
  }
});

test("a receipt arriving after the server clears its attempt is removed", async () => {
  const f = fixture("pilot", true, "receipt");
  const work = [item(f.pilotRequest)];
  try {
    await f.runtime.processWorkUpdate(work);
    f.enqueue(1);
    await f.runtime.processWorkUpdate(work);
    await until(() => f.settlements.length === 1, "server records ambiguity");
    f.queue.shift();
    await f.runtime.processWorkUpdate(work);
    expect(f.runtime.coordinator.getActiveDelivery("pilot")).toBeUndefined();

    await reportReceipt(f, 1);
    await until(
      () =>
        !readdirSync(f.journalDirectory).some((file) =>
          file.endsWith(".receipt"),
        ),
      "the receipt for the settled attempt is removed",
    );
    expect(f.settlements.map(({ outcome }) => outcome)).toEqual(["in_doubt"]);
  } finally {
    await f.dispose();
  }
});

test("a pending successor leaves the pilot running until its receipt settles", async () => {
  const f = fixture("pilot", true, "receipt");
  const work = [item(f.pilotRequest)];
  try {
    await f.runtime.processWorkUpdate(work);
    f.enqueue(1);
    f.enqueue(2);
    await f.runtime.processWorkUpdate(work);
    await until(() => f.settlements.length === 1, "server records ambiguity");

    const owned = f.ready(f.pilotRequest);
    const successorWork = [
      {
        ...item(f.pilotRequest, owned),
        pendingEpoch: 2,
        pendingPolicy: "cancel-unstarted",
        bindings: [pending(f.pilotRequest, owned), pending(f.successor)],
      },
    ];
    await f.runtime.processWorkUpdate(successorWork);
    expect(f.actions).not.toContain("edge:release");
    expect(f.runtime.coordinator.getActiveDelivery("pilot")?.state).toBe(
      "ambiguous",
    );

    await reportReceipt(f, 1);
    await f.runtime.processWorkUpdate(successorWork);
    expect(
      f.settlements.map(({ delivery_id, outcome }) => [delivery_id, outcome]),
    ).toEqual([
      ["delivery-1", "in_doubt"],
      ["delivery-1", "applied"],
    ]);
    expect(turnStarts(f)).toHaveLength(1);
    expect(f.actions).toContain("edge:release");
    expect(f.actions).toContain("legacy-deliver:pilot:2:2");
    expect(f.runtime.coordinator.getActiveDelivery("pilot")).toBeUndefined();
  } finally {
    await f.dispose();
  }
});

test("the pilot replays its journal receipt on restart and never resends the started attempt", async () => {
  const f = fixture("pilot", true, "receipt");
  const { deliveryReceipts } = new FileExecutionOperationJournal(
    f.journalDirectory,
  );
  const signal = new AbortController().signal;
  const work = [item(f.pilotRequest)];
  try {
    f.rejectSettlements(true);
    await f.runtime.processWorkUpdate(work);
    f.enqueue(1);
    await f.runtime.processWorkUpdate(work);
    expect(f.runtime.coordinator.getActiveDelivery("pilot")?.state).toBe(
      "ambiguous",
    );
    await reportReceipt(f, 1);
    await f.runtime.processWorkUpdate(work);
    const saved = await deliveryReceipts.find(
      "pilot",
      f.deliveryThread,
      "delivery-1",
      signal,
    );
    expect(saved).toMatchObject({ provider_item_id: "provider-item-1" });
    await deliveryReceipts.record(
      "pilot",
      f.deliveryThread,
      {
        delivery_id: "already-settled",
        provider_item_id: "settled-item",
        turn: "settled-turn",
      },
      signal,
    );
    expect(f.runtime.coordinator.getActiveDelivery("pilot")?.state).toBe(
      "ambiguous",
    );

    f.rejectSettlements(false);
    const { restarted, work: resumed } = await f.restart();
    expect(
      await deliveryReceipts.find(
        "pilot",
        f.deliveryThread,
        "already-settled",
        signal,
      ),
    ).toBeUndefined();
    await until(
      () => f.events.filter(({ kind }) => kind === "receipt").length === 2,
      "restart replays the durable receipt",
    );
    await restarted.processWorkUpdate([resumed]);
    expect(
      f.settlements.filter(({ outcome }) => outcome === "applied"),
    ).toMatchObject([
      {
        delivery_id: "delivery-1",
        resolution_evidence: expect.stringContaining("provider-item-1"),
        fencing_token: "renewed-lease",
      },
    ]);
    expect(restarted.coordinator.getActiveDelivery("pilot")).toBeUndefined();
    expect(turnStarts(f)).toHaveLength(1);
  } finally {
    await f.dispose();
  }
});

test("a restart without a receipt holds the started attempt without resending", async () => {
  const f = fixture("pilot", true, "receipt");
  try {
    const work = [item(f.pilotRequest)];
    await f.runtime.processWorkUpdate(work);
    f.enqueue(1);
    f.enqueue(2);
    await f.runtime.processWorkUpdate(work);
    await until(() => f.settlements.length === 1, "server records ambiguity");

    const { restarted, work: resumed } = await f.restart();
    await restarted.processWorkUpdate([resumed]);
    expect(
      f.actions.filter((action) => action === "edge:delivery.start"),
    ).toHaveLength(1);
    expect(turnStarts(f)).toHaveLength(1);
    expect(restarted.coordinator.getActiveDelivery("pilot")).toMatchObject({
      attemptId: "attempt-1",
      state: "ambiguous",
    });
    expect(f.settlements.every(({ outcome }) => outcome === "in_doubt")).toBe(
      true,
    );
  } finally {
    await f.dispose();
  }
});

test("an in-doubt image stays readable until the server releases its delivery", async () => {
  const f = fixture("pilot", true, "receipt");
  const work = [item(f.pilotRequest)];
  try {
    await f.runtime.processWorkUpdate(work);
    f.enqueue(1, true);
    await f.runtime.processWorkUpdate(work);
    expect(f.runtime.coordinator.getActiveDelivery("pilot")?.state).toBe(
      "ambiguous",
    );
    const input = turnStarts(f)[0]?.params?.input as {
      type: string;
      path?: string;
    }[];
    const imagePath = input.find(({ type }) => type === "localImage")?.path;
    expect(imagePath).toBeDefined();
    expect([...readFileSync(imagePath!)]).toEqual([...f.image]);
    await until(() => f.settlements.length === 1, "server records ambiguity");
    f.queue.shift();
    await f.runtime.processWorkUpdate(work);
    expect(f.runtime.coordinator.getActiveDelivery("pilot")).toBeUndefined();
    expect(existsSync(imagePath!)).toBe(false);
  } finally {
    await f.dispose();
  }
});

test("with the flag off a queued message still drains through the legacy rail", async () => {
  const f = fixture("pilot", false, "receipt");
  try {
    await f.runtime.processWorkUpdate([item(f.pilotRequest)]);
    expect(f.actions).toEqual([
      "legacy-start:pilot:1",
      "claim-delivery:pilot:1",
      "legacy-deliver:pilot:1:2",
      "claim-delivery:pilot:1",
    ]);
    expect(f.appServer.wire()).toEqual([]);
  } finally {
    await f.dispose();
  }
});
