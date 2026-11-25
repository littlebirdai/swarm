import Dexie from "dexie";
import type { Patch } from "mutative";
import { AUTH_JWT_STORAGE_KEY } from "../../lib/localAuth";
import {
  HYDRATION_CRITICAL_READ_KEYS,
  HYDRATION_DEFERRED_KEYS,
} from "../../store/clientSyncRegistry";
import { loadCache } from "../../store/persistence/boot-loader";
import { writePatchesToIDB } from "../../store/persistence/collection-writer";
import { COLLECTION_TABLES, db } from "../../store/persistence/db";
import { loadConversationMessages } from "../../store/persistence/message-cache";
import {
  deleteInBatches,
  RETENTION_DELETE_BATCH,
} from "../../store/persistence/retention";
import {
  check,
  EVENT_COUNT,
  eventId,
  eventRow,
  focusId,
  liveIds,
  messageRows,
  MESSAGE_COUNT,
  SESSION_COUNT,
  sessionRows,
  WRITE_ROWS,
  writeRows,
} from "./fixture";

const owner = "synthetic-principal";
const events = COLLECTION_TABLES.externalEvents;
let observedWrite:
  | PromiseWithResolvers<{ commitAt: number; mutateMs: number }>
  | undefined;

db.use({
  stack: "dbcore",
  name: "storage-benchmark-commit",
  create(core) {
    return {
      table(name) {
        const table = core.table(name);
        if (name !== "externalEvents") return table;
        return {
          ...table,
          mutate(request) {
            const observer = observedWrite;
            if (!observer || request.type !== "put")
              return table.mutate(request);
            observedWrite = undefined;
            const transaction = Dexie.currentTransaction;
            const mutateStarted = performance.now();
            const result = table.mutate(request);
            const mutateMs = performance.now() - mutateStarted;
            transaction.on("complete", () =>
              observer.resolve({ commitAt: performance.now(), mutateMs }),
            );
            transaction.on("abort", () =>
              observer.reject(new Error("Dexie product write aborted")),
            );
            return result;
          },
        };
      },
    };
  },
});

export async function seedDexie() {
  const header = btoa(JSON.stringify({ alg: "RS256" }));
  const payload = btoa(
    JSON.stringify({
      aud: "convex",
      iss: location.origin,
      sub: `${owner}|synthetic-session`,
    }),
  );
  localStorage.setItem(AUTH_JWT_STORAGE_KEY, `${header}.${payload}.fixture`);
  await db.meta.bulkPut([
    { key: "currentUser", value: { _id: owner } },
    { key: "liveInboxIdList", value: liveIds },
    { key: "lastFocusedConversationId", value: focusId },
  ]);
  await COLLECTION_TABLES.sessions.bulkPut(sessionRows());
  await db.conversationMessageMeta.put({
    convId: focusId,
    pagination: undefined,
    latestTimestamp: 0,
  });
  await db.conversationMessageRows.bulkPut(messageRows());
  for (let start = 0; start < EVENT_COUNT; start += 2000) {
    const length = Math.min(2000, EVENT_COUNT - start);
    await events.bulkPut(
      Array.from({ length }, (_, index) => eventRow(start + index)),
    );
  }
  db.close({ disableAutoOpen: false });
}

export async function dexieBoot() {
  db.close({ disableAutoOpen: false });
  const started = performance.now();
  await db.open();
  const openMs = performance.now() - started;
  const paintStarted = performance.now();
  const critical = await loadCache(HYDRATION_CRITICAL_READ_KEYS);
  const focused = await loadConversationMessages(focusId);
  const paintMs = performance.now() - paintStarted;
  check(
    critical?.sessions && liveIds.every((id) => critical.sessions[id]),
    "Dexie paint sessions missing",
  );
  check(
    focused?.messages.length === MESSAGE_COUNT,
    "Dexie paint messages missing",
  );
  const deferred = await loadCache(HYDRATION_DEFERRED_KEYS, {
    pending: critical.pending,
  });
  const fullBootMs = performance.now() - started;
  const externalEvents = deferred?.externalEvents as
    | Record<string, ReturnType<typeof eventRow>>
    | undefined;
  check(
    externalEvents && Object.keys(externalEvents).length === EVENT_COUNT,
    "Dexie deferred rows missing",
  );
  check(
    Object.keys(critical.sessions).length === SESSION_COUNT,
    "Dexie boot sessions missing",
  );
  return { openMs, paintMs, fullBootMs, externalEvents };
}

export async function dexieWrite(
  externalEvents: Record<string, ReturnType<typeof eventRow>>,
  revision: number,
) {
  const rows = writeRows(revision);
  const patches: Patch[] = rows.map((row) => ({
    op: "replace",
    path: ["externalEvents", row._id],
    value: row,
  }));
  for (const row of rows) externalEvents[row._id] = row;
  const observer = Promise.withResolvers<{
    commitAt: number;
    mutateMs: number;
  }>();
  observedWrite = observer;
  const timeout = setTimeout(
    () =>
      observer.reject(new Error("Dexie product write did not reach commit")),
    3000,
  );
  try {
    const started = performance.now();
    writePatchesToIDB(patches, { externalEvents });
    const submitted = performance.now();
    const { commitAt, mutateMs } = await observer.promise;
    const observed = await events.bulkGet(rows.map((row) => row._id));
    check(
      observed.every((row) => row?.revision === revision),
      "Dexie product write did not commit",
    );
    return {
      mainMs: submitted - started + mutateMs,
      savedMs: commitAt - started,
    };
  } finally {
    clearTimeout(timeout);
    observedWrite = undefined;
  }
}

export async function dexieRetention(start: number) {
  const rows = Array.from({ length: RETENTION_DELETE_BATCH }, (_, index) =>
    eventRow(start + index),
  );
  const ids = rows.map((row) => row._id);
  const started = performance.now();
  await deleteInBatches(events, ids);
  const elapsed = performance.now() - started;
  check(
    (await events.bulkGet(ids)).every((row) => row === undefined),
    "Dexie retention batch did not commit",
  );
  await events.bulkPut(rows);
  return elapsed;
}

export async function dexieReopen(revision: number) {
  await db.open();
  const visible = await events.bulkGet(
    writeRows(revision).map((row) => row._id),
  );
  return visible.every((row) => row?.revision === revision);
}

export async function dexieStage(revision: number, staged: () => void) {
  await db.transaction("rw", events, async () => {
    await events.bulkPut(writeRows(revision).slice(0, WRITE_ROWS / 2));
    staged();
    await Dexie.waitFor(new Promise<void>(() => {}));
  });
}

export async function dexieVerify(revision: number) {
  return (
    (await dexieReopen(revision)) &&
    (await events.count()) +
      (await COLLECTION_TABLES.sessions.count()) +
      (await db.conversationMessageRows.count()) ===
      EVENT_COUNT + SESSION_COUNT + MESSAGE_COUNT &&
    (await events.get(eventId(EVENT_COUNT - 1)))?.revision === 0
  );
}

export const closeDexie = () => db.close({ disableAutoOpen: false });
