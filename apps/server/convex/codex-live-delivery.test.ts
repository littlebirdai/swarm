import { expect, jest, test } from "bun:test";
import { OWNED_CODEX_CHECKPOINT_PREFIX } from "@codecast/agent-clients/executionBinding";
import { parsePermitsNextResponse } from "@codecast/edge-contract";
import { asUser } from "../test-helpers/database.testkit";
import {
  boot,
  machine,
  setupRunLease,
} from "../test-helpers/run-lease.testkit";
import { recordDocuments } from "../test-helpers/document-reads.testkit";
import { api } from "./_generated/api";
import { EXECUTION_PROTOCOL_CAPABILITIES } from "./executionBindings";
import {
  makeSessionStartsDb,
  sessionStartOf,
  syncSessionStart,
} from "./lib/sessionStarts";

const ownedHandle =
  OWNED_CODEX_CHECKPOINT_PREFIX +
  JSON.stringify({
    threadId: "thr_owned",
    sandbox: "read-only",
    approvalPolicy: "on-request",
  });

function listWork(
  { t, bearer }: Awaited<ReturnType<typeof setupRunLease>>,
  ownedCodexConversationId?: string,
) {
  return t.query(api.executionBindings.listExecutionWork, {
    owner_device_id: machine,
    daemon_boot_id: boot,
    protocol_version: 1,
    capabilities: [...EXECUTION_PROTOCOL_CAPABILITIES],
    api_token: bearer,
    ...(ownedCodexConversationId
      ? { owned_codex_conversation_id: ownedCodexConversationId }
      : {}),
  });
}

test.each([
  ["legacy Codex", { handle: "thr_legacy" }],
  [
    "another agent",
    {
      actual_agent: "claude",
      requested_agent: "claude",
      transport: "tmux",
      handle: ownedHandle,
    },
  ],
] as const)(
  "%s stays on normal execution work without a pilot wake",
  async (_label, binding) => {
    const f = await setupRunLease();
    await f.t.run(({ db }) => db.patch(f.binding, binding));
    const before = await listWork(f, f.conversation);
    expect(before).toHaveLength(1);
    expect(before[0]).not.toHaveProperty("nextDeliverySequence");
    await asUser(f.t, f.owner).mutation(api.dispatch.dispatch, {
      action: "sendMessage",
      args: [f.conversation, "from the composer", [], "no-pilot-wake"],
    });
    expect(await listWork(f, f.conversation)).toEqual(before);
  },
);

test("a composer send changes the selected Codex work result and becomes an edge permit", async () => {
  const f = await setupRunLease();
  await f.t.run(({ db }) => db.patch(f.binding, { handle: ownedHandle }));
  const claim = await f.claim("live-codex-test");
  if (claim.status !== "granted") throw new Error("Expected a grant");
  const { v, session, run, fencing_token } = claim;
  const fence = { v, session, run, fencing_token };
  const call = async (operation: string, body: object) => {
    const response = await f.t.fetch(`/edge/v1/${operation}`, {
      method: "POST",
      headers: { authorization: `Bearer ${f.bearer}` },
      body: JSON.stringify(body),
    });
    expect(response.ok).toBe(true);
    return response.json();
  };
  const initial = parsePermitsNextResponse(await call("permits.next", fence));
  if (!initial.ok || initial.value.status !== "permit")
    throw new Error("Expected an initial permit");
  const { delivery_id, attempt_id, seq, intent, sender } = initial.value;
  const permit = { ...fence, delivery_id, attempt_id, seq, intent, sender };
  expect(await call("delivery.start", permit)).toMatchObject({
    status: "started",
  });
  expect(
    await call("delivery.settle", { ...permit, outcome: "applied" }),
  ).toMatchObject({ status: "recorded" });

  const before = await listWork(f, f.conversation);
  const legacyWork = await listWork(f);
  const otherSelection = await listWork(f, "other-conversation");
  expect(before[0]?.nextDeliverySequence).toBe(2);
  expect(legacyWork[0]).not.toHaveProperty("nextDeliverySequence");
  expect(otherSelection).toEqual(legacyWork);

  await asUser(f.t, f.owner).mutation(api.dispatch.dispatch, {
    action: "sendMessage",
    args: [f.conversation, "from the composer", [], "live-codex-message"],
  });
  expect((await listWork(f, f.conversation))[0]?.nextDeliverySequence).toBe(3);
  expect(await listWork(f)).toEqual(legacyWork);
  expect(await call("permits.next", fence)).toMatchObject({
    status: "permit",
    state: "new",
    delivery_id: "live-codex-message",
    sender: { kind: "person", id: f.owner },
    input: [{ type: "text", text: "from the composer" }],
  });
});

test("the projected execution work feed ignores transcript writes and still tracks safety", async () => {
  jest.useFakeTimers();
  try {
    const f = await setupRunLease();
    const insert = (i: number) =>
      asUser(f.t, f.owner).mutation(api.messages.addMessage, {
        conversation_id: f.conversation,
        role: "assistant",
        content: `Working update ${i}`,
        message_uuid: `work-feed-${i}`,
        timestamp: Date.now() + i,
      });
    const unbackfilled = await recordDocuments(() => listWork(f));
    expect(unbackfilled.result).toHaveLength(1);
    expect(unbackfilled.reads.has(f.conversation)).toBe(true);

    await f.t.run(({ db }) => syncSessionStart(db, f.conversation));
    const scoped = await recordDocuments(() => listWork(f));
    expect(scoped.result).toEqual(unbackfilled.result);
    expect(scoped.reads.has(f.conversation)).toBe(false);
    for (let i = 0; i < 4; i++) {
      const ingest = await recordDocuments(() => insert(i));
      expect(ingest.writes.has(f.conversation)).toBe(true);
      expect([...ingest.writes].filter((id) => scoped.reads.has(id))).toEqual(
        [],
      );
    }

    for (const block of [
      { pending_api_error_kind: "safety" as const },
      {
        session_error:
          "Safety stop: This request was blocked by our safety systems.",
      },
    ]) {
      await f.t.run(({ db }) =>
        makeSessionStartsDb(db, db).patch(f.conversation, block),
      );
      expect(await listWork(f)).toEqual([]);
      await f.t.run(({ db }) =>
        makeSessionStartsDb(db, db).patch(f.conversation, {
          pending_api_error_kind: undefined,
          session_error: undefined,
        }),
      );
      expect(await listWork(f)).toEqual(unbackfilled.result);
    }
  } finally {
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});

test.each([
  ["a missing card", false],
  ["a legacy card without a safety verdict", true],
] as const)(
  "execution work checks conversation safety with %s",
  async (_label, legacyCard) => {
    const f = await setupRunLease();
    if (legacyCard) {
      await f.t.run(async ({ db }) => {
        await syncSessionStart(db, f.conversation);
        const card = await sessionStartOf(db, f.conversation);
        if (!card) throw new Error("Expected a session card");
        await db.patch(card._id, { execution_safety_blocked: undefined });
      });
    }
    expect(await listWork(f)).toHaveLength(1);

    for (const block of [
      { pending_api_error_kind: "safety" as const, session_error: undefined },
      {
        pending_api_error_kind: undefined,
        session_error:
          "Safety stop: This request was blocked by our safety systems.",
      },
    ]) {
      await f.t.run(({ db }) => db.patch(f.conversation, block));
      const work = await recordDocuments(() => listWork(f));
      expect(work.result).toEqual([]);
      expect(work.reads.has(f.conversation)).toBe(true);
    }
  },
);
