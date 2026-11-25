import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import {
  asUser,
  scheduledJobs,
  serverTest,
} from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import { api, internal } from "./_generated/api";
import type { Id, TableNames } from "./_generated/dataModel";
import { encryptRefreshToken } from "./googleOAuth";
import { commandArgumentsFingerprint } from "./localFirstCommands";
import schema from "./schema";

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

function outboxFor(owner: Id<"users">, timestamp = Date.now()) {
  return { id: `${timestamp}:${crypto.randomUUID()}`, owner, age_ms: 0 };
}

async function setup() {
  const t = serverTest();
  const rows = await t.run(async ({ db }) => {
    const fixtures = fixtureRows(db, "dispatch outbox");
    const owner = await fixtures.user();
    const other = await fixtures.user();
    const conversation = await fixtures.conversation(owner);
    const message = await fixtures.message(conversation);
    return { owner, other, conversation, message };
  });
  const actor = asUser(t, rows.owner);
  const outbox = outboxFor(rows.owner);
  return { t, actor, outbox, ...rows };
}

test("every journaled action returns its stored result before any write or job", async () => {
  const { t, actor, owner, conversation } = await setup();
  const inventory = await Bun.file(
    new URL(
      "../../../docs/architecture/client-dispatch-outbox.md",
      import.meta.url,
    ),
  ).text();
  const actions = inventory
    .split("\n")
    .filter((line) => line.startsWith("| `"))
    .flatMap((line) =>
      [...line.split("|")[1].matchAll(/`([^`]+)`/g)].map((match) => match[1]),
    );
  expect(actions).toHaveLength(397);
  expect(new Set(actions).size).toBe(actions.length);

  const examples = await Promise.all(
    actions.map(async (action) => {
      const outbox = outboxFor(owner);
      const result = { first: action };
      return {
        outbox,
        action,
        result,
        receipt: {
          owner,
          action,
          id_hash: await commandArgumentsFingerprint(outbox.id),
          response: await encryptRefreshToken(
            JSON.stringify({ result, __syncAckV1: [], __syncAckV2: [] }),
            outbox.id,
            "swarm-dispatch-outbox-v1",
          ),
          expires_at: Date.now() + 86_400_000,
        },
      };
    }),
  );
  await t.run(async ({ db }) => {
    for (const { receipt } of examples)
      await db.insert("dispatch_outbox_receipts", receipt);
  });
  const snapshot = () =>
    t.run(({ db }) =>
      Promise.all(
        (Object.keys(schema.tables) as TableNames[]).map((table) =>
          db.query(table).collect(),
        ),
      ),
    );
  const before = await snapshot();
  const jobs = await scheduledJobs(t);
  for (const { action, outbox, result } of examples) {
    const replay = await actor.mutation(api.dispatch.dispatch, {
      action,
      args: [],
      outbox,
      patches: { conversations: { [conversation]: { title: action } } },
    });
    expect({ action, replay }).toEqual({ action, replay: result });
  }
  expect(await snapshot()).toEqual(before);
  expect(await scheduledJobs(t)).toEqual(jobs);
});

test.each([
  "adoptSession",
  "answerDecision",
  "applyWorkbench",
  "clearCurrentConversation",
  "clearSelection",
  "clearSidePanelSession",
  "closeSidePanel",
  "closeTab",
  "deferSession",
  "initPagination",
  "injectSession",
  "markKilling",
  "navigateToSession",
  "openSidePanel",
  "openTab",
  "patchConversation",
  "pinSession",
  "renameSession",
  "requestNavigate",
  "saveCurrentTabState",
  "selectPanelSession",
  "setActiveBucketFilter",
  "setActiveProjectFilter",
  "setCloudSessionMode",
  "setCloudSharedCheckout",
  "setConversationAgent",
  "setConversationAgentDefinition",
  "setConversationModel",
  "setCurrentConversation",
  "setCurrentSession",
  "setIsolatedWorktreeMode",
  "setNavCollapsed",
  "setPagination",
  "setSessionCharacter",
  "setSessionCharacters",
  "setSessionRest",
  "setViewingDismissedId",
  "snoozeSession",
  "stageCloseLeaf",
  "stageExpandLeaf",
  "stageFocusLeaf",
  "stageInsertLeaf",
  "stageMoveLeaf",
  "stageSetLeafPath",
  "stageSetSizes",
  "switchTab",
  "toggleBucketFilterTerm",
  "toggleCollapsedSection",
  "toggleFavorite",
  "toggleProjectFilterTerm",
  "toggleSidePanel",
  "touchMru",
  "updateClientDismissed",
  "updateSessionProject",
  "updateTab",
  "wakeSnoozedSession",
  "wsHide",
  "wsSetPresentation",
  "wsSetSize",
  "wsShow",
  "wsToggle",
])("%s does not replace an intervening write on replay", async (action) => {
  const { t, actor, outbox, conversation } = await setup();
  const request = {
    action,
    args: [],
    patches: { conversations: { [conversation]: { title: "First" } } },
  };
  const first = await actor.mutation(api.dispatch.dispatch, {
    ...request,
    outbox,
    ack_positions: true,
  });
  expect(await t.run(({ db }) => db.get(conversation))).toMatchObject({
    title: "First",
  });
  await actor.mutation(api.dispatch.dispatch, {
    ...request,
    patches: { conversations: { [conversation]: { title: "Newer" } } },
  });
  expect(
    await actor.mutation(api.dispatch.dispatch, {
      ...request,
      outbox,
      ack_positions: true,
    }),
  ).toEqual(first);
  expect(await t.run(({ db }) => db.get(conversation))).toMatchObject({
    title: "Newer",
  });
});

test("create and delete each apply once and return the first result", async () => {
  const { t, actor, outbox, owner } = await setup();
  const create = {
    action: "createSavedView",
    args: [{ name: "My view", page: "tasks", prefs: {} }],
    outbox,
  };
  const view = await actor.mutation(api.dispatch.dispatch, create);
  expect(await actor.mutation(api.dispatch.dispatch, create)).toBe(view);
  expect(
    await t.run(({ db }) => db.query("saved_views").collect()),
  ).toHaveLength(1);
  const remove = {
    action: "deleteSavedView",
    args: [view],
    outbox: outboxFor(owner),
  };
  const removed = await actor.mutation(api.dispatch.dispatch, remove);
  expect(await actor.mutation(api.dispatch.dispatch, remove)).toEqual(removed);
  expect(await t.run(({ db }) => db.query("saved_views").collect())).toEqual(
    [],
  );
});

test("a replay does not append another task comment", async () => {
  const { t, actor, owner, outbox } = await setup();
  await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "append task comment");
    await rows.task(owner, { short_id: "ct-100", workspace: `user:${owner}` });
  });
  const request = {
    action: "addTaskComment",
    args: ["ct-100", "One comment"],
    outbox,
  };
  const first = await actor.mutation(api.dispatch.dispatch, request);
  expect(await actor.mutation(api.dispatch.dispatch, request)).toEqual(first);
  const comments = await t.run(({ db }) => db.query("task_comments").collect());
  expect(comments).toHaveLength(1);
  expect(comments[0]).toMatchObject({ text: "One comment" });
});

test("a replay does not enqueue a second message", async () => {
  const { t, actor, outbox, conversation } = await setup();
  const request = {
    action: "sendMessage",
    args: [conversation, "One message"],
    outbox,
  };
  const first = await actor.mutation(api.dispatch.dispatch, request);
  expect(await actor.mutation(api.dispatch.dispatch, request)).toEqual(first);
  const queued = await t.run(({ db }) =>
    db.query("pending_messages").collect(),
  );
  expect(queued).toHaveLength(1);
  expect(queued[0]).toMatchObject({ content: "One message" });
});

test("a replay does not schedule another job when the action can run again", async () => {
  const { t, actor, outbox, conversation } = await setup();
  const request = {
    action: "requestNavPromptIndex",
    args: [conversation],
    outbox,
  };
  const first = await actor.mutation(api.dispatch.dispatch, request);
  const jobs = () =>
    scheduledJobs(t, internal.conversations.backfillNavPromptsPage);
  const firstJobs = await jobs();
  expect(firstJobs).toHaveLength(1);
  await t.run(({ db }) =>
    db.patch(conversation, {
      nav_prompts_indexed_at: undefined,
      nav_prompts_backfill_started_at: undefined,
    }),
  );
  expect(await actor.mutation(api.dispatch.dispatch, request)).toEqual(first);
  expect(await jobs()).toEqual(firstJobs);
});

test("a repeated team write does not overwrite a newer team setting", async () => {
  const { t, actor, owner, outbox } = await setup();
  const team = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "team replay");
    const teamId = await rows.team();
    await rows.membership(owner, teamId, { role: "admin" });
    return teamId;
  });
  const request = { action: "renameTeam", args: [team, "First name"], outbox };
  const first = await actor.mutation(api.dispatch.dispatch, request);
  expect(await t.run(({ db }) => db.get(team))).toMatchObject({
    name: "First name",
  });
  await actor.mutation(api.dispatch.dispatch, {
    action: request.action,
    args: [team, "New name"],
  });
  expect(await actor.mutation(api.dispatch.dispatch, request)).toEqual(first);
  expect(await t.run(({ db }) => db.get(team))).toMatchObject({
    name: "New name",
  });
});

test("a duplicate bookmark toggle returns the original result and retains the bookmark", async () => {
  const { t, actor, outbox, conversation, message } = await setup();
  const request = { action: "toggleBookmark", args: [conversation, message] };
  expect(
    await actor.mutation(api.dispatch.dispatch, { ...request, outbox }),
  ).toBe(true);
  expect(
    await actor.mutation(api.dispatch.dispatch, { ...request, outbox }),
  ).toBe(true);
  expect(await t.run(({ db }) => db.query("bookmarks").collect())).toHaveLength(
    1,
  );
  expect(await actor.mutation(api.dispatch.dispatch, request)).toBe(false);
  expect(await t.run(({ db }) => db.query("bookmarks").collect())).toHaveLength(
    0,
  );
});

test("source creation and key rotation return the original results without persisting plaintext", async () => {
  const { t, actor, outbox, owner } = await setup();
  const create = {
    action: "createOpsSource",
    args: [{ name: "example", provider: "http", workspace: "personal" }],
    outbox,
  };
  const source = await actor.mutation(api.dispatch.dispatch, create);
  const rotate = {
    action: "rotateOpsSourceKey",
    args: [source.source_id],
    outbox: outboxFor(owner),
  };
  expect(await actor.mutation(api.dispatch.dispatch, create)).toEqual(source);
  const rotated = await actor.mutation(api.dispatch.dispatch, rotate);
  expect(await actor.mutation(api.dispatch.dispatch, rotate)).toEqual(rotated);
  expect(typeof source.ingest_key).toBe("string");
  expect(typeof rotated.ingest_key).toBe("string");
  expect(rotated.ingest_key).not.toBe(source.ingest_key);
  expect(
    await t.run(({ db }) => db.query("event_sources").collect()),
  ).toHaveLength(1);
  const receipts = await t.run(({ db }) =>
    db.query("dispatch_outbox_receipts").collect(),
  );
  expect(receipts).toHaveLength(2);
  expect(JSON.stringify(receipts)).not.toContain(source.ingest_key);
  expect(JSON.stringify(receipts)).not.toContain(rotated.ingest_key);
});

test("owner is checked before a receipt can be read or a patch can be applied", async () => {
  const { t, actor, outbox, other, conversation } = await setup();
  const request = {
    action: "patchConversation",
    args: [],
    patches: { conversations: { [conversation]: { title: "Owner only" } } },
    outbox,
  };
  const wrong = asUser(t, other);
  await expect(wrong.mutation(api.dispatch.dispatch, request)).rejects.toThrow(
    "different account",
  );
  await actor.mutation(api.dispatch.dispatch, request);
  await expect(wrong.mutation(api.dispatch.dispatch, request)).rejects.toThrow(
    "different account",
  );
  await wrong.mutation(api.dispatch.dispatch, {
    ...request,
    outbox: { ...outbox, owner: other },
  });
  expect(
    await t.run(({ db }) => db.query("dispatch_outbox_receipts").collect()),
  ).toHaveLength(2);
});

test("a refused side effect rolls back the patch and receipt and a retry can succeed", async () => {
  const { t, actor, outbox, owner, conversation, message } = await setup();
  await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "invalid bookmark relationship");
    const otherConversation = await rows.conversation(owner);
    await db.patch(message, { conversation_id: otherConversation });
  });
  const request = {
    action: "toggleBookmark",
    args: [conversation, message],
    patches: { conversations: { [conversation]: { title: "Retry" } } },
    outbox,
  };
  await expect(actor.mutation(api.dispatch.dispatch, request)).rejects.toThrow(
    "Bookmark message does not belong to the conversation",
  );
  expect(await t.run(({ db }) => db.get(conversation))).not.toMatchObject({
    title: "Retry",
  });
  expect(
    await t.run(({ db }) => db.query("dispatch_outbox_receipts").collect()),
  ).toEqual([]);
  await t.run(({ db }) => db.patch(message, { conversation_id: conversation }));
  expect(await actor.mutation(api.dispatch.dispatch, request)).toBe(true);
  expect(await t.run(({ db }) => db.get(conversation))).toMatchObject({
    title: "Retry",
  });
});

test("pruning an expired receipt cannot make an old dispatch runnable again", async () => {
  const { t, actor, owner, outbox } = await setup();
  const expired = {
    owner,
    id: `${Date.now() - 9 * 86_400_000}:${crypto.randomUUID()}`,
    age_ms: 9 * 86_400_000,
  };
  const request = { action: "patchConversation", args: [], outbox: expired };
  await t.run(({ db }) =>
    db.insert("dispatch_outbox_receipts", {
      owner,
      id_hash: "expired",
      action: request.action,
      response: "unused",
      expires_at: Date.now() - 1,
    }),
  );
  await actor.mutation(api.dispatch.dispatch, {
    ...request,
    outbox: { ...expired, age_ms: 0 },
  });
  jest.setSystemTime(Date.now() + 8 * 86_400_000);
  await actor.mutation(api.dispatch.dispatch, { ...request, outbox });
  await t.mutation(internal.dispatchReceipts.pruneOutboxReceipts, {});
  const receipts = await t.run(({ db }) =>
    db.query("dispatch_outbox_receipts").collect(),
  );
  expect(receipts).toHaveLength(1);
  expect(receipts[0].id_hash).not.toBe("expired");
  await expect(actor.mutation(api.dispatch.dispatch, request)).rejects.toThrow(
    "outside its delivery window",
  );
});

test.each([25 * 3_600_000, -9 * 86_400_000])(
  "a live client with clock offset %i gets a receipt anchored on server time",
  async (offset) => {
    const { t, actor, owner } = await setup();
    const request = {
      action: "patchConversation",
      args: [],
      outbox: outboxFor(owner, Date.now() + offset),
    };
    await actor.mutation(api.dispatch.dispatch, request);
    const receipt = await t.run(({ db }) =>
      db.query("dispatch_outbox_receipts").unique(),
    );
    expect(receipt?.expires_at).toBe(Date.now() + 8 * 86_400_000);
  },
);

test("an outbox ID requires a cryptographically sized suffix", async () => {
  const { actor, owner } = await setup();
  await expect(
    actor.mutation(api.dispatch.dispatch, {
      action: "patchConversation",
      args: [],
      outbox: { owner, id: `${Date.now()}:short`, age_ms: 0 },
    }),
  ).rejects.toThrow("must contain a random suffix");
});

test("a replay uses the current acknowledgement flag and the original result", async () => {
  const { actor, outbox, conversation, message } = await setup();
  const request = {
    action: "toggleBookmark",
    args: [conversation, message],
    outbox,
    patches: { conversations: { [conversation]: { title: "Bookmark" } } },
  };
  expect(await actor.mutation(api.dispatch.dispatch, request)).toBe(true);
  const flagged = await actor.mutation(api.dispatch.dispatch, {
    ...request,
    ack_positions: true,
  });
  expect(flagged).toEqual({
    result: true,
    __syncAckV1: expect.any(Array),
    __syncAckV2: expect.any(Array),
  });
  expect(await actor.mutation(api.dispatch.dispatch, request)).toBe(true);
});

test("a replay drops acknowledgements for a team that the owner left", async () => {
  const { t, actor, outbox, owner } = await setup();
  const { team, membership } = await t.run(async ({ db }) => {
    const fixtures = fixtureRows(db, "left team");
    const team = await fixtures.team();
    return { team, membership: await fixtures.membership(owner, team) };
  });
  const acks = [`user:${owner}`, `team:${team}`].map((scope_key) => ({
    scope_key,
  }));
  const response = await encryptRefreshToken(
    JSON.stringify({ result: true, __syncAckV1: acks, __syncAckV2: acks }),
    outbox.id,
    "swarm-dispatch-outbox-v1",
  );
  await t.run(async ({ db }) => {
    await db.insert("dispatch_outbox_receipts", {
      owner,
      action: "patchConversation",
      id_hash: await commandArgumentsFingerprint(outbox.id),
      response,
      expires_at: Date.now() + 86_400_000,
    });
  });
  const replay = () =>
    actor.mutation(api.dispatch.dispatch, {
      action: "patchConversation",
      args: [],
      outbox,
      ack_positions: true,
    });
  expect(await replay()).toEqual({
    result: true,
    __syncAckV1: acks,
    __syncAckV2: acks,
  });
  await t.run(({ db }) => db.delete(membership));
  expect(await replay()).toEqual({
    result: true,
    __syncAckV1: [acks[0]],
    __syncAckV2: [acks[0]],
  });
});

test("a large document create and its replay both return the full original document", async () => {
  const { t, actor, outbox } = await setup();
  const content = "large body ".repeat(73_000);
  const request = {
    action: "createDoc",
    args: [{ title: "Large note", content }],
    result: { receiptActionVersion: 1, commandId: crypto.randomUUID() },
    outbox,
  };
  const first = await actor.mutation(api.dispatch.dispatch, request);
  expect(first.result.row.content).toContain(content.trim());
  expect(await actor.mutation(api.dispatch.dispatch, request)).toEqual(first);
  const chunks = await t.run(({ db }) =>
    db.query("dispatch_outbox_receipts").collect(),
  );
  expect(chunks.length).toBeGreaterThan(1);
  expect(
    Math.max(...chunks.map((row) => row.response.length)),
  ).toBeLessThanOrEqual(512 * 1024);
  expect(await t.run(({ db }) => db.query("docs").collect())).toHaveLength(1);
  jest.advanceTimersByTime(8 * 86_400_000);
  await t.mutation(internal.dispatchReceipts.pruneOutboxReceipts, {});
  expect(
    await t.run(({ db }) => db.query("dispatch_outbox_receipts").collect()),
  ).toEqual([]);
});

test("a repeated capture-length read schedules its read only once", async () => {
  const { t, actor, outbox, owner } = await setup();
  const source = await actor.mutation(api.dispatch.dispatch, {
    action: "createOpsSource",
    args: [{ name: "Replay source", provider: "sdk", workspace: "personal" }],
  });
  const replay = await t.run(({ db }) =>
    db.insert("replays", {
      workspace: `user:${owner}`,
      source_id: source.source_id,
      short_id: "rp-1",
      external_id: "capture",
      provider: "sdk",
      started_at: Date.now(),
      created_at: Date.now(),
      updated_at: Date.now(),
      counts: { clicks: 0, errors: 0, failed_requests: 0 },
      group_ids: [],
      chunk_keys: [],
      dom_t0: 1,
      dom_chunk_keys: ["fixture.json.gz"],
    }),
  );
  const request = {
    action: "checkReplayCaptureLength",
    args: [replay],
    outbox,
  };
  const first = await actor.mutation(api.dispatch.dispatch, request);
  const jobs = () => scheduledJobs(t, internal.replays.captureLengthOne);
  const scheduled = await jobs();
  expect(scheduled).toHaveLength(1);
  expect(await actor.mutation(api.dispatch.dispatch, request)).toEqual(first);
  expect(await jobs()).toEqual(scheduled);
});
