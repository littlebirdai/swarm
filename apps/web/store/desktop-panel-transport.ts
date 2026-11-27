import type { ReplicationChannel, ReplicationMessage } from "@platform/engine";
import { REPLICATED_STORE_KEYS } from "./clientSyncRegistry";
import { desktopPanelScopeEnabled } from "./desktop-panel-keys";
import { replicationTransport } from "./storage-transport";

type Hello = Extract<ReplicationMessage, { type: "hello" }>;
type Mut = Extract<ReplicationMessage, { type: "mut" }> & {
  detailInvalidation?: { settled?: { to: string } };
};
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
) {
  let control: BroadcastChannel | undefined;
  const peers = new Map<
    string,
    { keys: Set<string>; seen: number; channel: BroadcastChannel }
  >();

  const forget = (id: string) => {
    peers.get(id)?.channel.close();
    peers.delete(id);
  };
  const pulse = (channel: BroadcastChannel) => {
    for (const [id, peer] of peers) {
      if (Date.now() - peer.seen >= SCOPE_LEASE_MS) forget(id);
    }
    postScope(channel, { type: "host", hostId });
  };
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  return {
    activate() {
      if (control) return;
      const active = new BroadcastChannel(`${name}:scope`);
      control = active;
      heartbeat = setInterval(() => pulse(active), SCOPE_PULSE_MS);
      pulse(active);
    },
    channel: {
      onMessage(callback) {
        const stop = legacy.onMessage((message) => {
          if (message.type === "hello" && peers.has(message.from)) return;
          callback(message);
        });
        const active = control;
        const receive = ({ data }: MessageEvent<ScopeSignal>) => {
          if (!active || data.type === "host" || data.type === "rejoin") return;
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
              postScope(active, { type: "rejoin", to: data.from, hostId });
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
        active?.addEventListener("message", receive);
        return () => {
          stop();
          active?.removeEventListener("message", receive);
        };
      },
      post(message) {
        if (message.type === "mut") {
          const target = (message as Mut).detailInvalidation?.settled?.to;
          const peer = target && peers.get(target);
          if (peer) {
            postScope(peer.channel, message);
            return;
          }
        }
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
    } satisfies ReplicationChannel,
    close() {
      clearInterval(heartbeat);
      control?.close();
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
    if (data.type === "mut") {
      receive(data);
      return;
    }
    if (
      data.type !== "update" &&
      data.type !== "snapshotChunk" &&
      data.type !== "snapshot"
    )
      return;
    if (modernHost && data.hostId !== modernHost) return;
    if (
      data.type === "snapshotChunk" &&
      data.request !== hello?.snapshotRequest
    )
      return;
    if (data.type === "snapshotChunk" || data.type === "snapshot") {
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

export function scopedSnapshotSource(
  channel: ReplicationChannel,
  readState: () => Record<string, unknown>,
) {
  let requested: readonly string[] | undefined;
  return {
    channel: {
      post: channel.post,
      onMessage(callback) {
        return channel.onMessage((message) => {
          if (
            message.type !== "hello" ||
            !("keys" in message) ||
            !Array.isArray(message.keys)
          ) {
            callback(message);
            return;
          }
          requested = message.keys.filter((key) =>
            REPLICATED_STORE_KEYS.includes(key),
          );
          try {
            callback(message);
          } finally {
            requested = undefined;
          }
        });
      },
    } satisfies ReplicationChannel,
    getState() {
      const state = readState();
      return requested
        ? Object.fromEntries(requested.map((key) => [key, state[key]]))
        : state;
    },
  };
}

export function panelReplicationTransport(
  name: string,
  selfId: string,
  eligible: boolean,
  keys?: readonly string[],
) {
  const legacy = () => replicationTransport(name, selfId);
  const transport = keys
    ? scopedFollowerChannel(name, selfId, keys, legacy)
    : legacy();
  const host =
    !keys && eligible && desktopPanelScopeEnabled()
      ? scopedHostChannel(name, selfId, transport.channel)
      : undefined;
  return {
    channel: host?.channel ?? transport.channel,
    activateHost: () => host?.activate(),
    close() {
      host?.close();
      transport.close();
    },
  };
}
