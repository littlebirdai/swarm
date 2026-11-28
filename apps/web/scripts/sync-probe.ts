import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { convexToJson, type Value } from "convex/values";
import { api } from "@codecast/convex/convex/_generated/api";
import {
  getFunctionName,
  type FunctionReference,
  type FunctionReturnType,
} from "convex/server";
import { asUser, serverTest } from "../../server/test-helpers/database.testkit";
import { fixtureRows } from "../../server/test-helpers/rows.testkit";
import { catchUp, scopeMetaKey } from "../hooks/use-sync-change-feed";
import { useInboxStore } from "../store/inboxStore";
import { flushSyncPublishes } from "../store/syncTransaction";
import { summarizeSyncProbe, timeSyncProbe } from "./sync-probe-timing";
import { syncProbeAnalytics } from "./sync-probe-metrics";

export async function runLocalProbe(samples: number, timeoutMs: number) {
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
  const waitForDelivery = async (revision: number, signal: AbortSignal) => {
    while (!signal.aborted) {
      const slot = await readSlot();
      signal.throwIfAborted();
      if (slot && slot.delivered_revision >= revision && !slot.pending)
        return slot.position;
      await delay(1, undefined, { signal });
    }
    throw signal.reason;
  };

  const cleanup = async () => {
    await owner.mutation(api.docs.remove, { id, api_token: token });
    const deleted = await backend.run(({ db }) => db.get(id));
    if (deleted) throw new Error("Probe document survived cleanup");
  };

  let failed = false;
  try {
    if (!row || row.workspace !== scopeKey || row.user_id !== ownerId)
      throw new Error(
        "Probe document is outside its owner's personal workspace",
      );
    const setupTimeout = AbortSignal.timeout(timeoutMs);
    const initialPosition = await waitForDelivery(1, setupTimeout).catch(
      (error: unknown) => {
        if (!setupTimeout.aborted) throw error;
        throw new Error(
          `Sync probe stalled at drainAndHeadBump during setup after ${timeoutMs} ms`,
        );
      },
    );
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

    let cursor = initialPosition;
    const store = useInboxStore.getState();
    useInboxStore.setState({ currentUser: { _id: ownerId } } as any);
    useInboxStore.getState().reconcileScopeSubscriptions(Date.now());
    store.syncTable("docs", [row], { isDelta: true });
    store.recordSyncMeta(scopeMetaKey(scopeKey), { cursor });
    flushSyncPublishes();

    const results = [];
    const reads = [];
    const encoder = new TextEncoder();
    for (let sample = 0; sample <= samples; sample++) {
      const title = `Sync probe ${sample + 1}`;
      const queryReads: { name: string; response: Value }[] = [];
      const result = await timeSyncProbe(async (start, signal) => {
        start("save");
        await owner.mutation(api.docs.webUpdate, { id, title });
        start("drainAndHeadBump");
        const position = await waitForDelivery(sample + 2, signal);
        start("getHeads");
        let rangeStarted = false;
        await catchUp({
          query: async (
            reference: FunctionReference<"query">,
            args: Record<string, unknown>,
          ) => {
            signal.throwIfAborted();
            const name = getFunctionName(reference);
            if (name === "syncLog:getRange" && !rangeStarted) {
              start("getRange");
              rangeStarted = true;
            }
            const response = await owner.query(reference, args);
            signal.throwIfAborted();
            queryReads.push({ name, response });
            if (name === "syncLog:getHeads") {
              const head = (
                response as FunctionReturnType<typeof api.syncLog.getHeads>
              ).heads.find((entry) => entry.scope_key === scopeKey);
              if (head?.position !== position || position <= cursor)
                throw new Error(
                  "Probe delivery did not advance the personal head",
                );
            }
            if (name === "syncLog:getRange") start("apply");
            return response;
          },
        });
        signal.throwIfAborted();
        flushSyncPublishes();
        const state = useInboxStore.getState();
        if (
          state.docs[String(id)]?.title !== title ||
          state.syncMeta[scopeMetaKey(scopeKey)]?.cursor !== position
        )
          throw new Error("Probe edit did not reach the client store");
        cursor = position;
      }, timeoutMs);
      if (sample > 0) {
        results.push(result);
        reads.push(
          queryReads.map(({ name, response }) => ({
            name,
            responseBytes: encoder.encode(
              JSON.stringify(convexToJson(response)),
            ).length,
          })),
        );
      }
    }
    return {
      samples: results.length,
      durations: summarizeSyncProbe(results),
      reads,
    };
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
      "interval-ms": { type: "string" },
      "publish-metrics": { type: "boolean" },
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
    const intervalMs = Number(values["interval-ms"]);
    if (values["interval-ms"] !== undefined) {
      if (!Number.isSafeInteger(intervalMs) || intervalMs < 60_000)
        throw new Error("--interval-ms must be an integer of at least 60000");
      syncProbeAnalytics(process.env);
      while (true) {
        const worker = Bun.spawn(
          [
            process.execPath,
            import.meta.path,
            "--samples",
            String(samples),
            "--timeout-ms",
            String(timeoutMs),
            "--publish-metrics",
          ],
          { stdout: "inherit", stderr: "inherit" },
        );
        if ((await worker.exited) !== 0)
          console.error("Sync probe batch failed");
        await delay(intervalMs);
      }
    }
    const metrics = values["publish-metrics"]
      ? syncProbeAnalytics(process.env)
      : undefined;
    const result = await runLocalProbe(samples, timeoutMs);
    if (metrics)
      await metrics.capturePersonless("sync_save_to_screen", {
        samples: result.samples,
        p50_ms: result.durations.total.p50,
        p95_ms: result.durations.total.p95,
      });
    console.log(
      JSON.stringify({ mode: "in-process", unit: "ms", ...result }, null, 2),
    );
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
