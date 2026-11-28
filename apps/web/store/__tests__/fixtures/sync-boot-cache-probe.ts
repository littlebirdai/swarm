import { expect } from "bun:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import type { Patch } from "mutative";
import type { CacheStorage } from "../../persistence/storage";

export type CacheMutation = { table: string; type: string; keys: unknown[] };

export function createSyncBootCacheProbe(deps: {
  cacheStorage: CacheStorage;
  authPrincipal: { check(): void };
  installSignedInPrincipal(): void;
  principal: string;
  reopenDb(api: {
    indexedDB: IDBFactory;
    IDBKeyRange: typeof IDBKeyRange;
  }): Promise<void>;
  metaPut(entry: { key: string; value: unknown }): Promise<unknown>;
  writeOwnerStamp(principal: string, reason: string): Promise<void>;
}) {
  const { cacheStorage } = deps;
  let mutations: CacheMutation[] | undefined;

  const origWritePatches = cacheStorage.writePatches.bind(cacheStorage);
  const origDeleteDetails =
    cacheStorage.deleteInvalidatedDocDetails?.bind(cacheStorage);

  cacheStorage.writePatches = (patches: Patch[], state: any) => {
    if (mutations) {
      for (const patch of patches) {
        const table = String(patch.path[0] ?? "");
        if (!table || table === "pending") continue;
        const key = patch.path[1];
        mutations.push({
          table,
          type: patch.op === "remove" ? "delete" : "put",
          keys: key !== undefined ? [key] : [],
        });
      }
    }
    return origWritePatches(patches, state);
  };

  if (origDeleteDetails) {
    cacheStorage.deleteInvalidatedDocDetails = async (
      ids,
      current,
      archive,
    ) => {
      const deleted = await origDeleteDetails(ids, current, archive);
      if (mutations && deleted.length) {
        mutations.push({
          table: "docDetails",
          type: "delete",
          keys: deleted,
        });
      }
      return deleted;
    };
  }

  return {
    origWritePatches,
    getMutations: () => mutations,
    setMutations: (next: CacheMutation[] | undefined) => {
      mutations = next;
    },
    async seedCollection(
      key: string,
      rows: Array<{ _id: string } & Record<string, unknown>>,
    ) {
      const map = Object.fromEntries(rows.map((row) => [row._id, row]));
      await origWritePatches([{ op: "replace", path: [key], value: map }], {
        [key]: map,
        pending: {},
      });
      await cacheStorage.flushPersistence();
    },
    async readCollection(key: string) {
      return ((await cacheStorage.loadCache([key]))?.[key] ?? {}) as Record<
        string,
        any
      >;
    },
    async readDocDetailRefs() {
      return (await cacheStorage.readCachedDocDetails?.()) ?? [];
    },
    async waitFor(condition: () => boolean) {
      const deadline = Bun.nanoseconds() + 2_000_000_000;
      while (!condition() && Bun.nanoseconds() < deadline)
        await new Promise<void>((resolve) => setImmediate(resolve));
      expect(condition()).toBe(true);
    },
    async openCache() {
      deps.installSignedInPrincipal();
      deps.authPrincipal.check();
      await deps.reopenDb({ indexedDB: new IDBFactory(), IDBKeyRange });
      await deps.metaPut({
        key: "currentUser",
        value: { _id: deps.principal },
      });
      await deps.writeOwnerStamp(deps.principal, "confirmed");
      await cacheStorage.purgeLocalCache({
        keepPendingInputFor: deps.principal,
        reason: "test-reset",
      });
    },
  };
}
