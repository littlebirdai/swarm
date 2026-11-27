import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { getFunctionName, type FunctionReference } from "convex/server";
import { convexToJson } from "convex/values";
import { api, internal } from "@codecast/convex/convex/_generated/api";
import { asUser, serverTest } from "../../server/test-helpers/database.testkit";
import { fixtureRows } from "../../server/test-helpers/rows.testkit";
import {
  applyInboxListPayload,
  LIST_INBOX_SESSIONS_ARGS,
} from "../hooks/useLiveInboxSessions";
import { catchUp, scopeMetaKey } from "../hooks/use-sync-change-feed";
import { useInboxStore } from "../store/inboxStore";
import { flushSyncPublishes } from "../store/syncTransaction";

const mode = process.argv[2];
assert(mode === "subscription" || mode === "snapshot");
const samples = 30;
const size = 24;
const encoder = new TextEncoder();
const list = api.conversations.listInboxSessions;
const backend = serverTest();
const { viewer, id } = await backend.run(async ({ db }) => {
  const rows = fixtureRows(db, "inbox-log-probe");
  const viewer = await rows.user();
  const now = Date.now();
  const ids = await Promise.all(
    Array.from({ length: size }, (_, i) =>
      rows.conversation(viewer, {
        title: `Inbox probe ${i}`,
        started_at: now,
        updated_at: now,
        message_count: 1,
      }),
    ),
  );
  return { viewer, id: ids[0] };
});
const scope = `user:${viewer}`;
const owner = asUser(backend, viewer);
const snapshot = await owner.query(list, {
  ...LIST_INBOX_SESSIONS_ARGS,
  checkpoint: mode === "snapshot",
});
assert("sessions" in snapshot);
assert.equal(snapshot.sessions.length, size);
if (mode === "snapshot") {
  assert("checkpoint" in snapshot);
  assert.deepEqual(snapshot.checkpoint, { scope, position: 0 });
}
applyInboxListPayload(snapshot);
useInboxStore.getState().recordSyncMeta(scopeMetaKey(scope), { cursor: 0 });

const stats = new Map<
  string,
  {
    calls: number;
    bytes: number;
    executionMs: number;
  }
>();
let measured = false;
const lastPush = new Map<string, string>();
const query = async (
  reference: FunctionReference<"query">,
  args: Record<string, unknown>,
  subscription = false,
) => {
  const start = performance.now();
  const response = await owner.query(reference, args);
  const executionMs = performance.now() - start;
  const name = getFunctionName(reference);
  const json = JSON.stringify(convexToJson(response));
  const bytes =
    subscription && lastPush.get(name) === json
      ? 0
      : encoder.encode(json).length;
  if (subscription) lastPush.set(name, json);
  if (measured) {
    const stat = stats.get(name) ?? { calls: 0, bytes: 0, executionMs: 0 };
    stat.calls++;
    stat.bytes += bytes;
    stat.executionMs += executionMs;
    stats.set(name, stat);
  }
  return response;
};

for (let i = 0; i <= samples; i++) {
  const title = `Renamed probe ${i}`;
  await backend.mutation(internal.titleGeneration.setTitleAndSubtitle, {
    conversation_id: id,
    title,
  });
  const signal = AbortSignal.timeout(5000);
  while (true) {
    const slot = await backend.run(({ db }) =>
      db
        .query("sync_outbox")
        .withIndex("by_scope_entity", (q) =>
          q.eq("scope_key", scope).eq("entity_id", id),
        )
        .unique(),
    );
    if (slot && !slot.pending) break;
    await delay(1, undefined, { signal });
  }
  if (mode === "subscription") {
    const split = await query(
      list,
      { ...LIST_INBOX_SESSIONS_ARGS, split: true },
      true,
    );
    assert.equal(split.hot.length, size);
    applyInboxListPayload(split.hot);
  }
  await query(api.conversations.sessionsLiveness, { split: true }, true);
  const heads = await query(api.syncLog.getHeads, {}, true);
  await catchUp({
    query: (
      reference: FunctionReference<"query">,
      args: Record<string, unknown>,
    ) =>
      getFunctionName(reference) === getFunctionName(api.syncLog.getHeads)
        ? Promise.resolve(heads)
        : query(reference, args),
  });
  flushSyncPublishes();
  assert.equal(useInboxStore.getState().sessions[id]?.title, title);
  measured = true;
}

const total = { calls: 0, bytes: 0, executionMs: 0 };
for (const value of stats.values()) {
  total.calls += value.calls;
  total.bytes += value.bytes;
  total.executionMs += value.executionMs;
}
console.log(
  JSON.stringify({
    mode,
    samples,
    size,
    total,
    queries: Object.fromEntries(stats),
  }),
);
process.exit(0);
