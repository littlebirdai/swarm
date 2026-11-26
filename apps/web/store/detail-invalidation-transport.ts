import type {
  ReplicationChannel,
  ReplicationHost,
  ReplicationMessage,
} from "@platform/engine";
import type { DetailInvalidation } from "./doc-detail-cache";

const LOG_LIMIT = 128;
const REQUEST_LIMIT = 64;
const LEGACY_PEER_LEASE_MS = 5 * 60_000;

type Position = { hostId: string; seq: number };
type Request = DetailInvalidation & { requestId: string; toHost: string };
type Entry = { seq: number; ids: string[] };
type Capability = {
  version: 1;
  compatible?: boolean;
  position?: Position;
  replay?: string[];
  gap?: boolean;
  request?: Request;
  settled?: { hostId: string; to: string; requestId: string };
};
type Message = ReplicationMessage & { detailInvalidation?: Capability };

type Options = {
  selfId: string;
  channel: ReplicationChannel;
  host: () => ReplicationHost | null;
  verify: (
    request: DetailInvalidation,
    current: () => boolean,
  ) => Promise<string[]>;
  deleteDetails: (ids: string[], current: () => boolean) => Promise<string[]>;
  apply: (ids?: string[]) => void;
  current: () => boolean;
  now?: () => number;
};

export function createDetailInvalidationTransport(opts: Options) {
  const peers = new Map<string, { supported: boolean; expires: number }>();
  const positions = new Map<string, Position | undefined>();
  const log: Entry[] = [];
  const seen = new Map<string, "checking" | "settled">();
  const pending = new Map<string, DetailInvalidation>();
  let sequence = 0;
  let prunedThrough = 0;
  let position: Position | undefined;
  let legacyObserved = false;
  let knownHost: string | undefined;
  let compatibleHost: string | undefined;
  const now = opts.now ?? Date.now;

  const compatible = () => {
    for (const [id, peer] of peers) {
      if (!peer.supported && peer.expires <= now()) {
        peers.delete(id);
        positions.delete(id);
      }
    }
    return [...peers.values()].every((peer) => peer.supported);
  };

  const sendPending = () => {
    if (!compatibleHost || !opts.current()) return;
    for (const [requestId, evidence] of pending) {
      const msg: Message = {
        type: "mut",
        from: opts.selfId,
        updates: [],
        detailInvalidation: {
          version: 1,
          request: { ...evidence, requestId, toHost: compatibleHost },
        },
      };
      opts.channel.post(msg);
    }
  };

  const commit = async (
    request: DetailInvalidation,
    current: () => boolean,
  ): Promise<boolean> => {
    const verified = await opts.verify(request, current);
    if (!current()) return false;
    if (!verified.length) return true;
    const deleted = await opts.deleteDetails(verified, current);
    const host = opts.host();
    if (!current() || !host || !deleted.length) return false;
    log.push({ seq: host.seq() + 1, ids: deleted });
    if (log.length > LOG_LIMIT) prunedThrough = log.shift()!.seq;
    host.publish(
      compatible()
        ? [
            {
              key: "docDetails",
              kind: "authoritativeRemoval",
              ids: deleted,
              ...(legacyObserved ? { removes: deleted } : {}),
            },
          ]
        : [{ key: "docDetails", removes: deleted }],
    );
    acknowledge(deleted);
    return true;
  };

  function applyRequest(
    msg: Extract<ReplicationMessage, { type: "mut" }>,
    request: Request,
  ) {
    const host = opts.host();
    const current = () => opts.current() && opts.host() === host;
    if (
      !host ||
      !current() ||
      !compatible() ||
      peers.get(msg.from)?.supported !== true ||
      request.toHost !== opts.selfId ||
      !Array.isArray(request.ids) ||
      !request.ids.length ||
      request.ids.length > REQUEST_LIMIT ||
      request.ids.some((id) => typeof id !== "string")
    )
      return;
    const key = `${msg.from}:${request.requestId}`;
    const settle = () => {
      const response: Message = {
        type: "mut",
        from: opts.selfId,
        updates: [],
        detailInvalidation: {
          version: 1,
          settled: {
            hostId: opts.selfId,
            to: msg.from,
            requestId: request.requestId,
          },
        },
      };
      opts.channel.post(response);
    };
    const previous = seen.get(key);
    if (previous === "settled") {
      settle();
      return;
    }
    if (previous === "checking") return;
    seen.set(key, "checking");
    if (seen.size > LOG_LIMIT * 2) seen.delete(seen.keys().next().value!);
    void commit(request, current)
      .then((settled) => {
        if (!settled) seen.delete(key);
        else {
          seen.set(key, "settled");
          settle();
        }
      })
      .catch(() => {
        seen.delete(key);
      });
  }

  function acknowledge(ids: readonly string[]) {
    const removed = new Set(ids);
    for (const [key, evidence] of pending) {
      const remaining = evidence.ids.filter((id) => !removed.has(id));
      if (remaining.length) pending.set(key, { ...evidence, ids: remaining });
      else pending.delete(key);
    }
  }

  const channel: ReplicationChannel = {
    post(raw) {
      const msg: Message = { ...raw };
      if (msg.type === "hello")
        msg.detailInvalidation = { version: 1, position };
      if (msg.type === "update")
        msg.detailInvalidation = { version: 1, compatible: compatible() };
      if (msg.type === "snapshot" || msg.type === "snapshotChunk") {
        const supported = compatible() && peers.get(msg.to)?.supported === true;
        const previous = positions.get(msg.to);
        const gap =
          supported &&
          (previous
            ? previous.hostId !== opts.selfId || previous.seq < prunedThrough
            : prunedThrough > 0);
        msg.detailInvalidation = {
          version: 1,
          compatible: supported,
          gap,
          replay:
            supported && !gap && (msg.type === "snapshot" || msg.done)
              ? log
                  .filter(
                    (entry) =>
                      entry.seq > (previous?.seq ?? 0) && entry.seq <= msg.seq,
                  )
                  .flatMap((entry) => entry.ids)
              : undefined,
        };
      }
      opts.channel.post(msg);
    },
    onMessage: (receive) =>
      opts.channel.onMessage((raw) => {
        if (!opts.current()) return;
        const msg: Message = raw;
        const extension = msg.detailInvalidation;
        if (msg.type === "hello") {
          const wasCompatible = compatible();
          if (extension?.version !== 1) legacyObserved = true;
          peers.set(msg.from, {
            supported: extension?.version === 1,
            expires: now() + LEGACY_PEER_LEASE_MS,
          });
          positions.set(msg.from, extension?.position);
          if (wasCompatible && !compatible())
            opts.host()?.publish([{ key: "docDetails", upserts: [] }]);
        } else if (
          msg.type === "update" &&
          msg.hostId === knownHost &&
          extension?.version === 1
        ) {
          compatibleHost = extension.compatible ? knownHost : undefined;
        } else if (msg.type === "mut" && extension?.settled) {
          const settled = extension.settled;
          if (
            settled.to === opts.selfId &&
            settled.hostId === knownHost &&
            msg.from === knownHost
          )
            pending.delete(settled.requestId);
          return;
        } else if (msg.type === "mut" && extension?.request) {
          applyRequest(msg, extension.request);
          return;
        }
        receive(raw);
      }),
  };

  return {
    channel,
    report(evidence: DetailInvalidation): boolean {
      if (!opts.current()) return false;
      const host = opts.host();
      if (host) {
        const supported = compatible();
        const current = () => opts.current() && opts.host() === host;
        void commit(evidence, current).catch(() => {});
        return supported;
      }
      if (!compatibleHost) return false;
      for (let i = 0; i < evidence.ids.length; i += REQUEST_LIMIT) {
        const request = {
          ...evidence,
          ids: evidence.ids.slice(i, i + REQUEST_LIMIT),
        };
        pending.set(`${opts.selfId}:${++sequence}`, request);
        if (pending.size > LOG_LIMIT * 2)
          pending.delete(pending.keys().next().value!);
      }
      sendPending();
      return true;
    },
    onPosition(hostId: string, seq: number) {
      position = { hostId, seq };
    },
    onSnapshot(raw: ReplicationMessage) {
      const msg: Message = raw;
      if (msg.type !== "snapshot" && msg.type !== "snapshotChunk") return;
      const extension = msg.detailInvalidation;
      knownHost = msg.hostId;
      compatibleHost =
        extension?.version === 1 && extension.compatible
          ? msg.hostId
          : undefined;
      if (!compatibleHost) return;
      if (extension?.gap) opts.apply();
      else if (extension?.replay?.length) {
        opts.apply(extension.replay);
        acknowledge(extension.replay);
      }
      sendPending();
    },
    applyRemoval(ids: string[], origin: string) {
      if (!compatibleHost || origin !== compatibleHost) return;
      opts.apply(ids);
      acknowledge(ids);
    },
    promote() {
      knownHost = undefined;
      compatibleHost = undefined;
      const host = opts.host();
      const current = () =>
        opts.current() && opts.host() === host && compatible();
      if (host && current())
        for (const [id, request] of pending)
          void commit(request, current)
            .then((settled) => {
              if (settled) pending.delete(id);
            })
            .catch(() => {});
    },
  };
}
