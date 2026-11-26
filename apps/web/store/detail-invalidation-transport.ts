import type {
  ReplicationChannel,
  ReplicationHost,
  ReplicationMessage,
} from "@platform/engine";
import type { DetailInvalidation } from "./doc-detail-cache";

const LOG_LIMIT = 128;
const REQUEST_LIMIT = 64;

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
};

export function createDetailInvalidationTransport(opts: Options) {
  const peers = new Map<string, boolean>();
  const positions = new Map<string, Position | undefined>();
  const log: Entry[] = [];
  const seen = new Set<string>();
  const pending = new Map<string, DetailInvalidation>();
  let sequence = 0;
  let prunedThrough = 0;
  let position: Position | undefined;
  let compatibleHost: string | undefined;

  const compatible = () => [...peers.values()].every(Boolean);

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
  ) => {
    const verified = await opts.verify(request, current);
    if (!current() || !verified.length) return;
    const deleted = await opts.deleteDetails(verified, current);
    const host = opts.host();
    if (!current() || !deleted.length || !host) return;
    log.push({ seq: host.seq() + 1, ids: deleted });
    if (log.length > LOG_LIMIT) prunedThrough = log.shift()!.seq;
    host.publish([
      { key: "docDetails", kind: "authoritativeRemoval", ids: deleted },
    ]);
    acknowledge(deleted);
  };

  function applyRequest(
    msg: Extract<ReplicationMessage, { type: "mut" }>,
    request: Request,
  ) {
    const host = opts.host();
    const current = () =>
      opts.current() && opts.host() === host && compatible();
    if (
      !host ||
      !current() ||
      peers.get(msg.from) !== true ||
      request.toHost !== opts.selfId ||
      !request.ids.length ||
      request.ids.length > REQUEST_LIMIT ||
      seen.has(request.requestId)
    )
      return;
    seen.add(request.requestId);
    if (seen.size > LOG_LIMIT * 2) seen.delete(seen.values().next().value!);
    void commit(request, current).catch(() => {
      seen.delete(request.requestId);
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
        const supported = compatible() && peers.get(msg.to) === true;
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
          peers.set(msg.from, extension?.version === 1);
          positions.set(msg.from, extension?.position);
          if (wasCompatible && !compatible())
            opts.host()?.publish([{ key: "docDetails", upserts: [] }]);
        } else if (
          msg.type === "update" &&
          msg.hostId === compatibleHost &&
          extension?.compatible === false
        ) {
          compatibleHost = undefined;
        } else if (msg.type === "mut" && extension?.request) {
          applyRequest(msg, extension.request);
          return;
        }
        receive(raw);
      }),
  };

  return {
    channel,
    report(evidence: DetailInvalidation) {
      for (let i = 0; i < evidence.ids.length; i += REQUEST_LIMIT) {
        const request = {
          ...evidence,
          ids: evidence.ids.slice(i, i + REQUEST_LIMIT),
        };
        const key = `${opts.selfId}:${++sequence}`;
        pending.set(key, request);
        if (pending.size > LOG_LIMIT * 2)
          pending.delete(pending.keys().next().value!);
      }
      if (opts.host()) {
        const host = opts.host();
        const current = () =>
          opts.current() && opts.host() === host && compatible();
        if (current()) void commit(evidence, current).catch(() => {});
      } else sendPending();
    },
    onPosition(hostId: string, seq: number) {
      position = { hostId, seq };
    },
    onSnapshot(raw: ReplicationMessage) {
      const msg: Message = raw;
      if (msg.type !== "snapshot" && msg.type !== "snapshotChunk") return;
      const extension = msg.detailInvalidation;
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
      compatibleHost = undefined;
      const host = opts.host();
      const current = () =>
        opts.current() && opts.host() === host && compatible();
      if (host && current())
        for (const request of pending.values())
          void commit(request, current).catch(() => {});
    },
  };
}
