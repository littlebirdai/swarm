import { parseArgs } from "node:util";
import { api } from "@codecast/convex/convex/_generated/api";
import { getFunctionName, type FunctionReference } from "convex/server";
import { asUser, serverTest } from "../../server/test-helpers/database.testkit";
import { fixtureRows } from "../../server/test-helpers/rows.testkit";
import { catchUpScope, scopeMetaKey } from "../hooks/use-sync-change-feed";
import { useInboxStore } from "../store/inboxStore";
import { flushSyncPublishes } from "../store/syncTransaction";
import { summarizeSyncProbe, timeSyncProbe } from "./sync-probe-timing";

async function runLocalProbe(samples: number, timeoutMs: number) {
  const backend = serverTest();
  const token = crypto.randomUUID();
  const [ownerId, otherId] = await backend.run(async ({ db }) => {
    const rows = fixtureRows(db, "sync-probe");
    const ownerId = await rows.user({ name: "Probe owner" });
    const otherId = await rows.user({ name: "Probe observer" });
    await rows.token(ownerId, token);
    return [ownerId, otherId] as const;
  });
  const owner = asUser(backend, ownerId);
  const other = asUser(backend, otherId);
  const scopeKey = `user:${ownerId}`;
  const { id, row } = await owner.mutation(api.docs.webCreate, {
    title: "Sync probe",
    workspace: "personal",
  });
  const readSlot = () =>
    backend.run(({ db }) =>
      db
        .query("sync_outbox")
        .withIndex("by_scope_entity", (q) =>
          q.eq("scope_key", scopeKey).eq("entity_id", String(id)),
        )
        .unique(),
    );
  const readHead = async () => {
    const { heads } = await owner.query(api.syncLog.getHeads, {});
    const head = heads.find((head) => head.scope_key === scopeKey);
    if (!head) throw new Error("Probe owner has no personal sync head");
    return head;
  };
  const waitForDelivery = async (revision: number) => {
    const deadline = performance.now() + timeoutMs;
    do {
      const slot = await readSlot();
      if (slot && slot.delivered_revision >= revision && !slot.pending)
        return slot.position;
      await Bun.sleep(1);
    } while (performance.now() < deadline);
    throw new Error("Sync probe stalled at drainAndHeadBump");
  };

  const cleanup = async () => {
    await owner.mutation(api.docs.remove, { id, api_token: token });
    const slot = await readSlot();
    if (slot) await waitForDelivery(slot.revision);
    const deleted = await backend.run(({ db }) => db.get(id));
    if (deleted) throw new Error("Probe document survived cleanup");
  };

  let failed = false;
  try {
    if (!row || row.workspace !== scopeKey || row.user_id !== ownerId)
      throw new Error(
        "Probe document is outside its owner's personal workspace",
      );
    await waitForDelivery(1);
    const rangeArgs = { scope_key: scopeKey, from: 0, cargo: true };
    const hidden = await other.query(api.syncLog.getRange, rangeArgs);
    const hiddenDoc = await other.query(api.docs.webGetByIds, {
      ids: [String(id)],
    });
    if (
      !("authorized" in hidden) ||
      hidden.authorized !== false ||
      hiddenDoc.docs.length
    )
      throw new Error("Probe document is visible to another viewer");

    let cursor = (await readHead()).position;
    const store = useInboxStore.getState();
    store.syncTable("docs", [row], { isDelta: true });
    store.recordSyncMeta(scopeMetaKey(scopeKey), { cursor });
    flushSyncPublishes();

    const results = [];
    for (let sample = 0; sample < samples; sample++) {
      const title = `Sync probe ${sample + 1}`;
      results.push(
        await timeSyncProbe(async (start) => {
          start("save");
          await owner.mutation(api.docs.webUpdate, { id, title });
          start("drainAndHeadBump");
          const position = await waitForDelivery(sample + 2);
          start("getHeads");
          const head = await readHead();
          if (head.position !== position || position <= cursor)
            throw new Error("Probe delivery did not advance the personal head");
          start("getRange");
          await catchUpScope(
            {
              query: async (
                reference: FunctionReference<"query">,
                args: Record<string, unknown>,
              ) => {
                const result = await owner.query(reference, args);
                if (getFunctionName(reference) === "syncLog:getRange")
                  start("apply");
                return result;
              },
            },
            head,
            new Set(),
          );
          flushSyncPublishes();
          const state = useInboxStore.getState();
          if (
            state.docs[String(id)]?.title !== title ||
            state.syncMeta[scopeMetaKey(scopeKey)]?.cursor !== position
          )
            throw new Error("Probe edit did not reach the client store");
          cursor = position;
        }, timeoutMs),
      );
    }
    return summarizeSyncProbe(results);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await cleanup().catch((error: unknown) => {
      if (!failed) throw error;
      console.error("Sync probe cleanup failed", error);
    });
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      samples: { type: "string", default: "30" },
      "timeout-ms": { type: "string", default: "5000" },
    },
  });
  const samples = Number(values.samples);
  const timeoutMs = Number(values["timeout-ms"]);
  if (
    !Number.isSafeInteger(samples) ||
    samples < 1 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1
  )
    throw new Error("Use positive integers for --samples and --timeout-ms");
  try {
    const durations = await runLocalProbe(samples, timeoutMs);
    console.log(
      JSON.stringify(
        { mode: "in-process", samples, unit: "ms", durations },
        null,
        2,
      ),
    );
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
