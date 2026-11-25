import type { ReplicationChannel, ReplicationMessage } from "@platform/engine";
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

type Hello = Extract<ReplicationMessage, { type: "hello" }>;
type Mut = Extract<ReplicationMessage, { type: "mut" }>;
type ScopedHello = Hello & { keys: readonly string[] };
type ScopeSignal =
  | ScopedHello
  | Mut
  | { type: "presence"; from: string; hostId: string }
  | { type: "rejoin"; to: string; hostId: string }
  | { type: "leave"; from: string }
  | { type: "host"; hostId: string };

const SCOPE_PULSE_MS = 2000;
const SCOPE_LEASE_MS = SCOPE_PULSE_MS * 3;

function postScope(
  channel: BroadcastChannel,
  message: ScopeSignal | ReplicationMessage,
) {
  try {
    channel.postMessage(message);
  } catch (error) {
    console.error("[replication] failed to post", error);
  }
}

export function scopedHostChannel(
  name: string,
  hostId: string,
  legacy: ReplicationChannel,
): { channel: ReplicationChannel; close: () => void } {
  const control = new BroadcastChannel(`${name}:scope`);
  const peers = new Map<
    string,
    { keys: Set<string>; seen: number; channel: BroadcastChannel }
  >();

  const forget = (id: string) => {
    peers.get(id)?.channel.close();
    peers.delete(id);
  };
  const pulse = () => {
    for (const [id, peer] of peers) {
      if (Date.now() - peer.seen >= SCOPE_LEASE_MS) forget(id);
    }
    postScope(control, { type: "host", hostId });
  };
  const heartbeat = setInterval(pulse, SCOPE_PULSE_MS);
  pulse();

  return {
    channel: {
      onMessage(callback) {
        const stop = legacy.onMessage((message) => {
          if (message.type === "hello" && peers.has(message.from)) return;
          callback(message);
        });
        const receive = ({ data }: MessageEvent<ScopeSignal>) => {
          if (data.type === "host" || data.type === "rejoin") return;
          if (data.type === "mut") {
            callback(data);
            return;
          }
          if (data.type === "leave") {
            forget(data.from);
            return;
          }
          const peer = peers.get(data.from);
          if (peer) peer.seen = Date.now();
          if (data.type === "presence") {
            if (!peer && data.hostId === hostId)
              postScope(control, { type: "rejoin", to: data.from, hostId });
            return;
          }
          if (data.type !== "hello" || !Array.isArray(data.keys)) return;
          const keys = new Set(data.keys);
          peers.set(data.from, {
            keys,
            seen: Date.now(),
            channel:
              peer?.channel ??
              new BroadcastChannel(`${name}:scope:${data.from}`),
          });
          callback(data);
        };
        control.addEventListener("message", receive);
        return () => {
          stop();
          control.removeEventListener("message", receive);
        };
      },
      post(message) {
        if ("to" in message) {
          const peer = peers.get(message.to);
          if (peer) {
            postScope(peer.channel, message);
            return;
          }
        }
        legacy.post(message);
        if (message.type !== "update") return;
        for (const peer of peers.values())
          postScope(peer.channel, {
            ...message,
            updates: message.updates.filter(({ key }) => peer.keys.has(key)),
          });
      },
    },
    close() {
      clearInterval(heartbeat);
      control.close();
      for (const id of peers.keys()) forget(id);
    },
  };
}

export function scopedFollowerChannel(
  name: string,
  selfId: string,
  keys: readonly string[],
  legacyTransport: () => ReturnType<typeof replicationTransport>,
) {
  const control = new BroadcastChannel(`${name}:scope`);
  const addressed = new BroadcastChannel(`${name}:scope:${selfId}`);
  let legacy: ReturnType<typeof replicationTransport> | undefined;
  let fallback: ReturnType<typeof setTimeout> | undefined;
  let hello: ScopedHello | undefined;
  let modernHost: string | undefined;
  let receiver: ((message: ReplicationMessage) => void) | undefined;
  const resetHost = (hostId: string) =>
    receiver?.({
      type: "update",
      hostId,
      seq: 0,
      origin: hostId,
      updates: [],
    });
  const receive = (message: ReplicationMessage) => {
    const pending = hello;
    receiver?.(message);
    if (
      pending &&
      pending === hello &&
      ((message.type === "snapshot" && message.to === selfId) ||
        (message.type === "snapshotChunk" &&
          message.request === pending.snapshotRequest &&
          message.done))
    )
      hello = undefined;
  };
  const refresh = (delay: number) => {
    clearTimeout(fallback);
    fallback = setTimeout(() => {
      const wasScoped = modernHost !== undefined;
      modernHost = undefined;
      if (!legacy) {
        legacy = legacyTransport();
        legacy.channel.onMessage((message) => {
          if (!modernHost) receive(message);
        });
      }
      const pending = hello;
      if (wasScoped) resetHost("");
      if (pending && pending === hello) legacy.channel.post(pending);
    }, delay);
  };
  const onControl = ({ data }: MessageEvent<ScopeSignal>) => {
    if (data.type === "rejoin") {
      if (data.to === selfId && data.hostId === modernHost) resetHost("");
      return;
    }
    if (data.type !== "host") return;
    const changed = modernHost !== data.hostId;
    modernHost = data.hostId;
    refresh(SCOPE_LEASE_MS);
    if (changed) {
      const pending = hello;
      resetHost(data.hostId);
      if (pending && pending === hello) postScope(control, pending);
    } else {
      postScope(control, {
        type: "presence",
        from: selfId,
        hostId: data.hostId,
      });
    }
  };
  const onAddressed = ({ data }: MessageEvent<ReplicationMessage>) => {
    if (data.type !== "update" && data.type !== "snapshotChunk") return;
    if (modernHost && data.hostId !== modernHost) return;
    if (
      data.type === "snapshotChunk" &&
      data.request !== hello?.snapshotRequest
    )
      return;
    if (data.type === "snapshotChunk") {
      modernHost = data.hostId;
      refresh(SCOPE_LEASE_MS);
      legacy?.close();
      legacy = undefined;
    }
    receive(data);
  };
  control.addEventListener("message", onControl);
  addressed.addEventListener("message", onAddressed);
  refresh(SCOPE_PULSE_MS);

  return {
    channel: {
      post(message) {
        if (message.type === "hello") {
          hello = { ...message, keys };
          if (!modernHost && legacy) legacy.channel.post(hello);
          else postScope(control, hello);
        } else {
          if (message.type === "mut" && modernHost) {
            postScope(control, message);
            return;
          }
          const sender = legacy ?? legacyTransport();
          sender.channel.post(message);
          if (!legacy) sender.close();
        }
      },
      onMessage(callback) {
        receiver = callback;
        return () => {
          receiver = undefined;
        };
      },
    } satisfies ReplicationChannel,
    close() {
      clearTimeout(fallback);
      postScope(control, { type: "leave", from: selfId });
      control.close();
      addressed.close();
      legacy?.close();
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
  const followerWrite = (patches: Patch[], state: object) => {
    const local = followerPersistencePatches(patches);
    if (local.length) return writePatchesToIDB(local, state);
  };
  const bootWrite = (patches: Patch[], state: object) => {
    for (const patch of patches) skippedBeforeRole?.add(String(patch.path[0]));
    return followerWrite(patches, state);
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
