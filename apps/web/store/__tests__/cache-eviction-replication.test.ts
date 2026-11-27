import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  createReplicationFollower,
  createReplicationHost,
  type ReplicationChannel,
  type ReplicationHost,
  type ReplicationMessage,
  type ReplicationUpdate,
} from "@platform/engine";
import { pinDetailRows, resetDetailPins } from "../../lib/detail-rows";
import {
  cacheEvictionsFor,
  withCacheEvictions,
  withoutEvictionPatches,
} from "../cache-eviction";
import {
  resetDetailInvalidations,
  setDetailInvalidationReporter,
  detailReadPosition,
} from "../doc-detail-cache";
import {
  collectCompleteDocCrawlAbsences,
  hideInvalidatedDetails,
  verifyDetailInvalidation,
  type DetailAuthorityReader,
} from "../doc-detail-authority";
import { createDetailInvalidationTransport } from "../detail-invalidation-transport";
import { useInboxStore } from "../inboxStore";
import { applyUpdatesToStore } from "../sync-replication";
import { durableDeletes } from "../idb-collection-diff";

const flag = "VITE_CACHE_EVICTION_METADATA";
const original = process.env[flag];
const docId = "j".repeat(32);
const other = "k".repeat(32);
const workspace = "team:alpha";
const row = {
  _id: docId,
  workspace,
  title: "Document",
  content: "cached body",
};
const active = () => true;
const cleanup: Array<() => void> = [];

beforeEach(() => {
  process.env[flag] = "1";
  resetDetailInvalidations();
  useInboxStore
    .getState()
    .dropRows("docDetails", Object.keys(useInboxStore.getState().docDetails));
});

afterEach(() => {
  for (const stop of cleanup.splice(0).reverse()) stop();
  setDetailInvalidationReporter();
  resetDetailPins();
  if (original === undefined) delete process.env[flag];
  else process.env[flag] = original;
});

function hub() {
  const peers = new Map<string, (msg: ReplicationMessage) => void>();
  const sent: ReplicationMessage[] = [];
  let omit:
    | ((receiver: string, msg: ReplicationMessage) => boolean)
    | undefined;
  const waiters = new Set<(msg: ReplicationMessage) => void>();
  return {
    sent,
    channel(id: string): ReplicationChannel {
      return {
        onMessage(receive) {
          peers.set(id, receive);
          return () => {
            peers.delete(id);
          };
        },
        post(msg) {
          sent.push(msg);
          for (const [receiver, receive] of peers) {
            if (receiver !== id && !omit?.(receiver, msg)) receive(msg);
          }
          for (const resolve of waiters) resolve(msg);
        },
      };
    },
    omit(skip?: typeof omit) {
      omit = skip;
    },
    next(matches: (msg: ReplicationMessage) => boolean) {
      const { promise, resolve } = Promise.withResolvers<ReplicationMessage>();
      const wait = (msg: ReplicationMessage) => {
        if (!matches(msg)) return;
        waiters.delete(wait);
        resolve(msg);
      };
      waiters.add(wait);
      return promise;
    },
  };
}

function makeHost(
  bus: ReturnType<typeof hub>,
  reader?: DetailAuthorityReader,
  now?: () => number,
) {
  let host: ReplicationHost | null = null;
  const channel = bus.channel("host");
  const disk = new Map([[docId, row]]);
  const applied: string[][] = [];
  const options = reader
    ? createDetailInvalidationTransport({
        selfId: "host",
        channel,
        now,
        host: () => host,
        current: active,
        verify: (request, current) =>
          verifyDetailInvalidation(reader, request, current),
        async deleteDetails(ids, current) {
          if (!current()) return [];
          applied.push(ids);
          for (const id of ids) disk.delete(id);
          return ids;
        },
        apply() {},
      })
    : undefined;
  host = createReplicationHost({
    hostId: "host",
    channel: options?.channel ?? channel,
    getState: () => ({ docDetails: {} }),
    replicatedKeys: ["docDetails"],
    isCollectionKey: () => true,
    applyUpdates() {},
  });
  cleanup.push(host.stop);
  return { host, options, disk, applied };
}

function makeFollower(
  bus: ReturnType<typeof hub>,
  enabled: boolean,
  id = "follower",
) {
  const channel = bus.channel(id);
  const protocol = enabled
    ? createDetailInvalidationTransport({
        selfId: id,
        channel,
        host: () => null,
        current: active,
        async verify() {
          return [];
        },
        async deleteDetails() {
          return [];
        },
        apply: hideInvalidatedDetails,
      })
    : undefined;
  const follower = createReplicationFollower({
    selfId: id,
    channel: protocol?.channel ?? channel,
    replicatedKeys: ["docDetails"],
    isCollectionKey: () => true,
    onPosition: protocol?.onPosition,
    onSnapshot: protocol?.onSnapshot,
    applyUpdates(updates, origin, hostCommit) {
      for (const update of updates)
        if (update.kind === "authoritativeRemoval" && update.ids)
          protocol?.applyRemoval(update.ids, origin);
      applyUpdatesToStore(updates, {
        recoverDetails: !!protocol && hostCommit,
      });
    },
  });
  cleanup.push(follower.stop);
  return { follower, protocol };
}

const isAuthoritativeRemoval = (msg: ReplicationMessage) =>
  msg.type === "update" &&
  msg.updates.some((update) => update.kind === "authoritativeRemoval");

test("a cache eviction is absent from both its tee and the next whole-collection diff", () => {
  const bus = hub();
  const initial = { docDetails: { [docId]: row } };
  const host = createReplicationHost({
    hostId: "host",
    channel: bus.channel("host"),
    getState: () => initial,
    replicatedKeys: ["docDetails"],
    isCollectionKey: () => true,
    applyUpdates() {},
  });
  cleanup.push(host.stop);
  const gone = { docDetails: {} };
  withCacheEvictions([{ key: "docDetails", id: docId, observed: row }], () => {
    const patches = [{ op: "remove" as const, path: ["docDetails", docId] }];
    const evictions = cacheEvictionsFor(patches, gone);
    host.tee(withoutEvictionPatches(patches, evictions), gone, evictions);
  });
  expect(host.seq()).toBe(0);
  expect(initial.docDetails[docId]).toBe(row);
  const next = { docDetails: { [other]: { ...row, _id: other } } };
  const patches = [
    { op: "replace" as const, path: ["docDetails"], value: next.docDetails },
  ];
  host.tee(patches, next);
  expect(bus.sent).toEqual([
    expect.objectContaining({
      updates: [{ key: "docDetails", upserts: [next.docDetails[other]] }],
    }),
  ]);
});

test("a whole-collection diff in the same commit drops only the authoritative id", () => {
  const bus = hub();
  const gone = { ...row, _id: other };
  const initial = { docDetails: { [docId]: row, [other]: gone } };
  const host = createReplicationHost({
    hostId: "host",
    channel: bus.channel("host"),
    getState: () => initial,
    replicatedKeys: ["docDetails"],
    isCollectionKey: () => true,
    applyUpdates() {},
  });
  cleanup.push(host.stop);
  const state = { docDetails: {} };
  withCacheEvictions([{ key: "docDetails", id: docId, observed: row }], () => {
    const patches = [
      { op: "replace" as const, path: ["docDetails"], value: {} },
    ];
    host.tee(patches, state, cacheEvictionsFor(patches, state));
  });
  expect(bus.sent).toEqual([
    expect.objectContaining({
      updates: [{ key: "docDetails", removes: [other] }],
    }),
  ]);
  expect(initial.docDetails[docId]).toBe(row);
});

test("the disk diff preserves a cache-only removal even when the same id has an ordinary delete authorization", () => {
  const shadow = new Map([[docId, row]]);
  const next = new Map<string, unknown>();
  expect(
    durableDeletes(
      "docDetails",
      [docId],
      { [`docDetails:${docId}`]: { type: "exclude" } },
      shadow,
      next,
      new Set([docId]),
    ),
  ).toEqual([]);
  expect(next.get(docId)).toBe(row);
});

test.each(["access", "archive", "crawl"] as const)(
  "a follower's %s invalidation removes the detail even when the host has no row",
  async (cause) => {
    const bus = hub();
    const host = makeHost(bus, {
      async detail() {
        return cause === "archive" ? { ...row, archived_at: 1 } : null;
      },
      async page(scope) {
        expect(scope).toBe(workspace);
        return { page: [], isDone: true, continueCursor: "" };
      },
    });
    const follower = makeFollower(bus, true);
    expect(follower.follower.synced()).toBe(true);
    useInboxStore.getState().syncRecord("docDetails", docId, row);
    const delivered = bus.next(isAuthoritativeRemoval);
    follower.protocol?.report({
      ids: [docId],
      cause,
      ...(cause === "crawl" ? { workspace } : {}),
    });
    await delivered;
    expect(host.applied).toEqual([[docId]]);
    expect(host.disk.has(docId)).toBe(false);
    expect(useInboxStore.getState().docDetails[docId]).toBeUndefined();
  },
);

test("a supporting follower uses the legacy path when an older host omits capability", () => {
  const bus = hub();
  const { host } = makeHost(bus);
  const follower = makeFollower(bus, true);
  const store = useInboxStore.getState();
  store.syncRecord("taskComments", docId, {
    _id: docId,
    comments: [],
    as_of: 1,
    _cachedAt: 1,
  });
  cleanup.push(pinDetailRows("taskComments", [docId]));
  expect(follower.protocol?.report({ ids: [docId], cause: "access" })).toBe(
    false,
  );
  host.publish([{ key: "taskComments", removes: [docId] }]);
  expect(bus.sent.some((msg) => msg.type === "mut")).toBe(false);
  expect(useInboxStore.getState().taskComments[docId]).toBeDefined();
});

test("mixed cohorts confirm host removals through the legacy wire format and recover after a legacy peer expires", async () => {
  const bus = hub();
  let now = 0;
  const { host, options, disk } = makeHost(
    bus,
    {
      async detail() {
        return null;
      },
      async page() {
        return { page: [], isDone: true, continueCursor: "" };
      },
    },
    () => now,
  );
  const { protocol } = makeFollower(bus, true);
  const { follower: legacy } = makeFollower(bus, false, "legacy");
  expect(protocol?.report({ ids: [docId], cause: "access" })).toBe(false);
  expect(bus.sent.some((msg) => msg.type === "mut")).toBe(false);
  const legacyRemoval = bus.next(
    (msg) =>
      msg.type === "update" &&
      msg.updates.some((update) => update.removes?.includes(docId)),
  );
  expect(options?.report({ ids: [docId], cause: "access" })).toBe(false);
  await legacyRemoval;
  expect(disk.has(docId)).toBe(false);
  expect(bus.sent.some(isAuthoritativeRemoval)).toBe(false);
  legacy.stop();
  now += 10 * 60_000;
  host.publish([{ key: "docDetails", upserts: [] }]);
  const advertised = bus.next(isAuthoritativeRemoval);
  expect(protocol?.report({ ids: [other], cause: "access" })).toBe(true);
  const restored = await advertised;
  expect(restored).toMatchObject({
    updates: [{ ids: [other], removes: [other] }],
  });
});

test("election drains queued invalidations while a legacy peer is present", async () => {
  const bus = hub();
  const selfId = "promoted";
  const disk = new Map([[docId, row]]);
  const verified: string[][] = [];
  let host: ReplicationHost | null = null;
  const protocol = createDetailInvalidationTransport({
    selfId,
    channel: bus.channel(selfId),
    host: () => host,
    current: active,
    async verify(request) {
      verified.push(request.ids);
      return request.ids;
    },
    async deleteDetails(ids) {
      for (const id of ids) disk.delete(id);
      return ids;
    },
    apply() {},
  });
  const stopListening = protocol.channel.onMessage(() => {});
  cleanup.push(stopListening);
  protocol.enterSolo();
  expect(protocol.report({ ids: [docId], cause: "access" })).toBe(true);
  makeFollower(bus, false, "legacy");
  stopListening();
  host = createReplicationHost({
    hostId: selfId,
    channel: protocol.channel,
    getState: () => ({ docDetails: {} }),
    replicatedKeys: ["docDetails"],
    isCollectionKey: () => true,
    applyUpdates() {},
  });
  cleanup.push(host.stop);

  protocol.promote();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(verified).toEqual([[docId]]);
  expect(disk.has(docId)).toBe(false);
  expect(bus.sent.filter((msg) => msg.type === "update")).toEqual([
    expect.objectContaining({
      hostId: selfId,
      updates: [{ key: "docDetails", removes: [docId] }],
    }),
  ]);
});

test("a compatible host advertisement resends queued invalidations once", async () => {
  const bus = hub();
  let now = 0;
  const { host, disk } = makeHost(
    bus,
    {
      async detail() {
        return null;
      },
      async page() {
        return { page: [], isDone: true, continueCursor: "" };
      },
    },
    () => now,
  );
  const { follower, protocol } = makeFollower(bus, true);
  const requests = () =>
    bus.sent.filter((msg) => msg.type === "mut" && msg.from === "follower");
  bus.omit((receiver, msg) => receiver === "host" && msg.type === "mut");
  expect(protocol?.report({ ids: [docId], cause: "access" })).toBe(true);
  expect(requests()).toHaveLength(1);
  const [first] = requests();
  const { follower: legacy } = makeFollower(bus, false, "legacy");
  expect(protocol?.report({ ids: [other], cause: "access" })).toBe(false);
  expect(disk.has(docId)).toBe(true);
  expect(requests()).toHaveLength(1);
  bus.omit();
  legacy.stop();
  now += 10 * 60_000;

  host.publish([{ key: "docDetails", upserts: [] }]);
  host.publish([{ key: "docDetails", upserts: [] }]);
  expect(follower.synced()).toBe(true);
  expect(requests()).toEqual([first, first]);
  await bus.next(isAuthoritativeRemoval);
  expect(disk.has(docId)).toBe(false);
});

test.each([false, true])(
  "a rejected request settles after resync (initial acknowledgement lost: %s)",
  async (loseAck) => {
    const bus = hub();
    let verified = 0;
    const { host } = makeHost(bus, {
      async detail() {
        verified++;
        return row;
      },
      async page() {
        return { page: [], isDone: true, continueCursor: "" };
      },
    });
    const { protocol } = makeFollower(bus, true);
    const settled = bus.next(
      (msg) => msg.type === "mut" && msg.from === "host",
    );
    if (loseAck)
      bus.omit(
        (receiver, msg) =>
          receiver === "follower" && msg.type === "mut" && msg.from === "host",
      );
    expect(protocol?.report({ ids: [docId], cause: "access" })).toBe(true);
    await settled;
    for (let gap = 0; gap < 2; gap++) {
      bus.omit(
        (receiver, msg) => receiver === "follower" && msg.type === "update",
      );
      host.publish([{ key: "docDetails", upserts: [] }]);
      bus.omit();
      host.publish([{ key: "docDetails", upserts: [] }]);
    }
    expect(
      bus.sent.filter((msg) => msg.type === "mut" && msg.from === "follower"),
    ).toHaveLength(loseAck ? 2 : 1);
    expect(verified).toBe(1);
  },
);

test.each([1, 129])(
  "a replication gap after %i missed invalidations clears unverified bodies and admits later host updates",
  async (count) => {
    const bus = hub();
    const { host, options, applied } = makeHost(bus, {
      async detail() {
        return null;
      },
      async page() {
        return { page: [], isDone: true, continueCursor: "" };
      },
    });
    const { follower } = makeFollower(bus, true);
    useInboxStore.getState().syncRecord("docDetails", docId, row);
    useInboxStore
      .getState()
      .syncRecord("docDetails", other, { ...row, _id: other });
    bus.omit(
      (receiver, msg) => receiver === "follower" && isAuthoritativeRemoval(msg),
    );
    for (let n = 0; n < count; n++) {
      const delivered = bus.next(isAuthoritativeRemoval);
      options?.report({
        ids: [n === 0 ? docId : `removed-${n}`],
        cause: "access",
      });
      await delivered;
    }
    bus.omit();
    host.publish([{ key: "docDetails", upserts: [] }]);
    expect(follower.synced()).toBe(true);
    expect(useInboxStore.getState().docDetails[docId]).toBeUndefined();
    expect(Boolean(useInboxStore.getState().docDetails[other])).toBe(
      count === 1,
    );
    expect(applied.flat()).not.toContain(other);
    host.publish([
      {
        key: "docDetails",
        upserts: [{ ...row, _id: other, content: "New host body" }],
      },
    ]);
    expect(useInboxStore.getState().docDetails[other]?.content).toBe(
      "New host body",
    );
  },
);

test("a complete workspace crawl includes a detail even when its thin row is missing", async () => {
  const reported: unknown[] = [];
  setDetailInvalidationReporter((evidence) => {
    reported.push(evidence);
    return true;
  });
  useInboxStore.getState().syncRecord("docDetails", docId, row);
  useInboxStore.getState().syncRecord("docDetails", other, {
    ...row,
    _id: other,
    workspace: "team:other",
  });
  expect(useInboxStore.getState().docs[docId]).toBeUndefined();
  await collectCompleteDocCrawlAbsences(
    workspace,
    new Set(),
    detailReadPosition(),
  );
  expect(reported).toEqual([{ cause: "crawl", workspace, ids: [docId] }]);
});

test("the host refuses stale or incomplete evidence", async () => {
  const reader = {
    async detail() {
      return row;
    },
    async page() {
      return { page: [], isDone: false, continueCursor: "" };
    },
  };
  expect(
    await verifyDetailInvalidation(
      reader,
      { cause: "access", ids: [docId] },
      active,
    ),
  ).toEqual([]);
  expect(
    await verifyDetailInvalidation(
      reader,
      { cause: "archive", ids: [docId] },
      active,
    ),
  ).toEqual([]);
  expect(
    await verifyDetailInvalidation(
      reader,
      { cause: "crawl", ids: [docId], workspace },
      active,
    ),
  ).toEqual([]);
});

test("a complete crawl cannot revoke an accessible document omitted from the list", async () => {
  expect(
    await verifyDetailInvalidation(
      {
        async detail() {
          return row;
        },
        async page() {
          return { page: [], isDone: true, continueCursor: "" };
        },
      },
      { cause: "crawl", ids: [docId], workspace },
      active,
    ),
  ).toEqual([]);
});

test("eviction rechecks the row generation, pins and pending writes before committing", async () => {
  const { evictDetailRows } = await import("../store-eviction");
  const { DETAIL_ROW_CAPS } = await import("../../lib/detail-rows");
  const key = "taskComments";
  const cap = DETAIL_ROW_CAPS[key];
  const rows = Object.fromEntries(
    Array.from({ length: cap + 3 }, (_, n) => {
      const id = String(n);
      return [id, { _id: id, _cachedAt: n, comments: [] }];
    }),
  );
  const state = useInboxStore.getState();
  const removed: string[] = [];
  const after = {
    ...state,
    taskComments: {
      ...rows,
      "0": { ...rows["0"], _cachedAt: cap + 4 },
    },
    pending: {
      [`${key}:2:body`]: { type: "field", ts: 1, value: "unsent" },
    },
    dropRows(_key: string, ids: string[]) {
      removed.push(...ids);
    },
  } as typeof state;
  let observations = 0;
  evictDetailRows(
    () => {
      if (observations++ === 0)
        return { ...state, taskComments: rows } as typeof state;
      cleanup.push(pinDetailRows(key, ["1"]));
      return after;
    },
    key,
    [],
  );
  expect(observations).toBe(2);
  expect(removed).toEqual([]);
});

test("document cache simulation snapshots detach collections on save and restore", async () => {
  const { __detailCacheSimSlots, invalidateDetailReads } =
    await import("../doc-detail-cache");
  const seam = __detailCacheSimSlots();
  const saved = seam.get();
  invalidateDetailReads([docId]);
  expect(saved.detailCache.invalidated.has(docId)).toBe(false);
  seam.set(saved);
  invalidateDetailReads([other]);
  expect(saved.detailCache.invalidated.has(other)).toBe(false);
  const current = seam.get();
  expect(current.detailCache.invalidated.has(other)).toBe(true);
  expect(current.detailCache.confirmed).not.toBe(saved.detailCache.confirmed);
  expect(current.detailCache.reads).not.toBe(saved.detailCache.reads);
  expect(current.detailCache.listeners).not.toBe(saved.detailCache.listeners);
});

test("a host update stops an old solo delete before the snapshot arrives", async () => {
  const bus = hub();
  const { host, disk } = makeHost(bus, {
    async detail() {
      return row;
    },
    async page() {
      return { page: [], isDone: true, continueCursor: "" };
    },
  });
  bus.omit(
    (receiver, msg) => receiver === "solo" && msg.type === "snapshotChunk",
  );
  const verdict = Promise.withResolvers<string[]>();
  const checking = Promise.withResolvers<void>();
  const protocol = createDetailInvalidationTransport({
    selfId: "solo",
    channel: bus.channel("solo"),
    host: () => null,
    current: active,
    verify() {
      checking.resolve();
      return verdict.promise;
    },
    async deleteDetails(ids, current) {
      if (!current()) return [];
      for (const id of ids) disk.delete(id);
      return ids;
    },
    apply() {},
  });
  const follower = createReplicationFollower({
    selfId: "solo",
    channel: protocol.channel,
    replicatedKeys: ["docDetails"],
    isCollectionKey: () => true,
    onSnapshot: protocol.onSnapshot,
    applyUpdates() {},
  });
  cleanup.push(follower.stop);
  expect(follower.synced()).toBe(false);
  protocol.enterSolo();
  expect(protocol.ownsDisk()).toBe(true);
  expect(protocol.report({ cause: "access", ids: [docId] })).toBe(true);
  await checking.promise;

  const restored = { ...row, content: "Restored by the host" };
  disk.set(docId, restored);
  host.publish([{ key: "docDetails", upserts: [restored] }]);
  expect(follower.synced()).toBe(false);
  expect(protocol.ownsDisk()).toBe(false);
  verdict.resolve([docId]);
  await verdict.promise;
  expect(disk.get(docId)).toEqual(restored);
});
