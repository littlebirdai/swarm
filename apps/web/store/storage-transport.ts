import type { PendingOutboxWrite, ReplicationChannel } from "@platform/engine";
import type { Patch } from "mutative";
import { CACHE_SCHEMA_VERSION, writePatchesToIDB } from "./idb-cache";
import { followerPersistencePatches } from "./followerPersistence";

// Election and transport are scoped to the account the window acts for: a
// host and its followers share one principal by construction, so a window
// that just signed in as someone else can never take a snapshot, an update or
// a mut from the previous account's host, and needs no per-message check.
// They are scoped to the store's schema too. After a deploy, windows run
// different builds until each reloads, and a host from an older build never
// mounts the feeders of a collection added since: its followers would wait on
// that collection forever. Every collection change bumps the schema version,
// so windows that cannot share a store elect separate hosts.
const LOCK_NAME = "codecast-sync-host";
const CHANNEL_NAME = "codecast-replication-v1";
export function replicationLockName(principalId: string): string {
  return `${LOCK_NAME}:${CACHE_SCHEMA_VERSION}:${principalId}`;
}
export function replicationChannelName(principalId: string): string {
  return `${CHANNEL_NAME}:${CACHE_SCHEMA_VERSION}:${principalId}`;
}

/**
 * The replication channel over BroadcastChannel. A message addressed to one
 * window (a snapshot, `to`) travels on that window's own channel, so only
 * the window that asked decodes it. On the shared channel every window
 * structured-cloned every other window's snapshot: ~100 MB each, 0.5 to 1 s
 * of main thread per copy, and a dev reload that brings back F windows at
 * once cost F² of them (2026-10-09). The follower inbox orders by seq and
 * buffers until its snapshot lands, so the two channels need no shared order.
 */
export function replicationTransport(
  name: string,
  selfId: string,
): { channel: ReplicationChannel; close: () => void } {
  const addressed = (to: string) => `${name}:to:${to}`;
  const shared = new BroadcastChannel(name);
  const own = new BroadcastChannel(addressed(selfId));
  const outboxes = new Map<string, BroadcastChannel>();
  const outbox = (to: string) => {
    let bc = outboxes.get(to);
    if (!bc) outboxes.set(to, (bc = new BroadcastChannel(addressed(to))));
    return bc;
  };
  const channel: ReplicationChannel = {
    post: (msg) => {
      try {
        ("to" in msg ? outbox(msg.to) : shared).postMessage(msg);
        // A snapshot answers one request; its outbox is not needed after it.
        if ("to" in msg && (msg.type === "snapshot" || msg.done)) {
          outboxes.get(msg.to)?.close();
          outboxes.delete(msg.to);
        }
      } catch (error) {
        // A non-cloneable value in a row is a bug upstream; replication must
        // never take the write path down with it.
        console.error("[replication] failed to post", error);
      }
    },
    onMessage: (cb) => {
      const handler = (e: MessageEvent) => cb(e.data);
      shared.addEventListener("message", handler);
      own.addEventListener("message", handler);
      return () => {
        shared.removeEventListener("message", handler);
        own.removeEventListener("message", handler);
      };
    },
  };
  return {
    channel,
    close: () => {
      shared.close();
      own.close();
      for (const bc of outboxes.values()) bc.close();
      outboxes.clear();
    },
  };
}

export function transportAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof BroadcastChannel !== "undefined" &&
    typeof navigator !== "undefined" &&
    !!(navigator as any).locks?.request
  );
}

export function replicationLock(principalId: string) {
  const name = replicationLockName(principalId);
  let releaseLock: (() => void) | null = null;
  let holdsLock = false;
  const lockAbort = new AbortController();

  const request = (stopped: () => boolean, onAcquired: () => void) => {
    (navigator as any).locks
      .request(name, { mode: "exclusive", signal: lockAbort.signal }, () => {
        // A grant that lands after stop() (the abort raced it: React's dev
        // double mount stops and restarts within one tick) must not be
        // held — returning releases it at once. Holding it here left a dead
        // instance as the origin's permanent lock holder, so every later
        // window fell back to solo host and never replicated.
        if (stopped()) return;
        // Hold the lock until stop(). The holder promise is created BEFORE
        // any host work runs and never rejects: a throw inside the promise
        // executor would settle it and release the lock while this window
        // still believed it was host — two "elected" hosts on one origin.
        const held = new Promise<void>((resolve) => {
          releaseLock = resolve;
        });
        holdsLock = true;
        try {
          onAcquired();
        } catch (error) {
          console.error("[replication] failed to become host", error);
        }
        return held;
      })
      .catch(() => {
        /* aborted on stop — never an error path */
      });
  };

  return {
    request,
    held: () => holdsLock,
    release: () => {
      lockAbort.abort();
      releaseLock?.();
      holdsLock = false;
    },
  };
}

export function replicationPersistence(getState: () => object) {
  // Until this window knows its role it persists only its per-window keys,
  // as a follower does. A window booting beside a living host would
  // otherwise write everything its feeders and the host's snapshot hand it
  // (fresh objects, so every row diffs as changed): on 2026-11-14 each new
  // desktop window rewrote the whole cache (100 to 220 MB a burst), and
  // outbox writes queued behind those bursts tripped the storage banner.
  // The shared keys skipped meanwhile are remembered; a window that ends up
  // host writes them once (a follower's host already has).
  let skippedBeforeRole: Set<string> | null = new Set();
  const followerWrite = (
    patches: Patch[],
    state: object,
    pending?: PendingOutboxWrite,
  ) => {
    const local = followerPersistencePatches(patches);
    if (local.length || pending?.length)
      return writePatchesToIDB(local, state, pending);
  };
  const bootWrite = (
    patches: Patch[],
    state: object,
    pending?: PendingOutboxWrite,
  ) => {
    for (const patch of patches) {
      const key = String(patch.path[0]);
      if (key !== "pending") skippedBeforeRole?.add(key);
    }
    return followerWrite(patches, state, pending);
  };
  // Host from here on: persist what was skipped while the role was open. Each
  // key goes as a whole-collection replace, so the write diffs against what is
  // on disk and puts only the rows that differ.
  const persistSkipped = () => {
    const keys = skippedBeforeRole;
    skippedBeforeRole = null;
    if (!keys?.size) return;
    const state = getState();
    writePatchesToIDB(
      [...keys].map((key) => ({
        op: "replace",
        path: [key],
        value: (state as Record<string, unknown>)[key],
      })),
      state,
    );
  };

  return {
    hostWrite: writePatchesToIDB,
    bootWrite,
    followerWrite,
    persistSkipped,
    discardSkipped: () => {
      skippedBeforeRole = null;
    },
  };
}
