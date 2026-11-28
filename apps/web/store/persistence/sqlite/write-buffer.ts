import { accountKeyOf } from "./hydrated-epoch";
import type { PendingWriteBatch } from "./patch-payload";
import type { CacheEpoch } from "./protocol";

export type WriteBuffer = {
  current(principal: string): PendingWriteBatch | null;
  ensure(principal: string): PendingWriteBatch;
  take(): PendingWriteBatch | null;
  clear(): void;
  followEpoch(epoch: CacheEpoch | null): void;
  purge(): void;
  scope(): number;
  holds(batch: PendingWriteBatch): boolean;
};

export function createWriteBuffer(activeKey: () => string | null): WriteBuffer {
  let batch: PendingWriteBatch | null = null;
  let seenKey: string | null = null;
  let scope = 0;

  const matches = (candidate: PendingWriteBatch, principal: string) =>
    candidate.principal === principal && candidate.accountKey === activeKey();

  return {
    current(principal) {
      return batch && matches(batch, principal) ? batch : null;
    },
    ensure(principal) {
      if (batch && !matches(batch, principal)) batch = null;
      batch ??= {
        principal,
        accountKey: activeKey(),
        scope,
        patches: [],
        state: {},
        evictions: new Map(),
        conversations: new Map(),
      };
      return batch;
    },
    take() {
      const taken = batch;
      batch = null;
      return taken;
    },
    clear() {
      batch = null;
    },
    followEpoch(epoch) {
      if (!epoch) {
        batch = null;
        return;
      }
      const key = accountKeyOf(epoch);
      if (seenKey === null) {
        seenKey = key;
        if (
          batch &&
          batch.accountKey === null &&
          batch.principal === epoch.principal
        )
          batch.accountKey = key;
      } else if (seenKey !== key) {
        seenKey = key;
        scope++;
      }
      if (batch && batch.accountKey !== key) batch = null;
    },
    purge() {
      scope++;
      batch = null;
    },
    scope: () => scope,
    holds(candidate) {
      return candidate.scope === scope;
    },
  };
}
