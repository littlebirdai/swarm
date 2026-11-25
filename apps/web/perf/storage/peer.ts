import { closeDexie, dexieReopen, dexieStage } from "./dexie-baseline";
import { check } from "./fixture";
import { startWorker } from "./worker-client";

type Command = {
  action: "handoff" | "crash";
  engine: "dexie" | "sqlite";
  revision: number;
};

export const storageLock = "synthetic-storage-owner";

export function openPeer() {
  const id = crypto.randomUUID();
  const channel = new BroadcastChannel(id);
  const replies: Record<
    string,
    PromiseWithResolvers<MessageEvent["data"]>
  > = {};
  let failure: Error | undefined;
  channel.onmessage = ({ data }) => {
    if (data.kind === "error") {
      failure = new Error(data.value);
      for (const reply of Object.values(replies)) reply.reject(failure);
      return;
    }
    (replies[data.kind] ??= Promise.withResolvers()).resolve(data.value);
  };
  const peer = window.open(`/peer?id=${id}`, id);
  check(peer, "Second window did not open");
  return {
    command(command: Command) {
      for (const key of Object.keys(replies)) delete replies[key];
      channel.postMessage(command);
    },
    reply(kind: string) {
      if (failure) return Promise.reject(failure);
      return (replies[kind] ??= Promise.withResolvers()).promise;
    },
    close() {
      peer.close();
      channel.close();
    },
    kill() {
      peer.close();
    },
  };
}

export function handlePeer(id: string) {
  const channel = new BroadcastChannel(id);
  const send = (kind: string, value?: unknown) =>
    channel.postMessage({ kind, value });
  channel.onmessage = async ({ data }: MessageEvent<Command>) => {
    const { action, engine, revision } = data;
    try {
      if (action === "crash") {
        await dexieStage(revision, () => send("staged"));
        return;
      }
      const pending = navigator.locks.request(storageLock, async () => {
        if (engine === "dexie") {
          try {
            send("visible", await dexieReopen(revision));
          } finally {
            closeDexie();
          }
        } else {
          const worker = startWorker();
          try {
            await worker.call("open");
            send("visible", await worker.call("verify", revision));
          } finally {
            await worker.close();
          }
        }
      });
      send("queued");
      await pending;
      send("released");
    } catch (error) {
      send("error", String(error));
    }
  };
  send("ready");
}
