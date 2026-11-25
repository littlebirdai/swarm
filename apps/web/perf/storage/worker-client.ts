import type { operations } from "./sqlite-worker";

let nextWorker = 0;

export function startWorker() {
  const name = `storage-benchmark-${++nextWorker}`;
  const worker = new Worker("/sqlite-worker.js", {
    type: "module",
    name,
  });
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  let nextId = 0;
  worker.onmessage = ({ data }) => {
    const waiter = pending.get(data.id);
    if (!waiter) return;
    pending.delete(data.id);
    if (data.error) waiter.reject(new Error(data.error));
    else waiter.resolve(data.value);
  };
  worker.onerror = (event) => {
    for (const waiter of pending.values())
      waiter.reject(new Error(event.message));
    pending.clear();
  };
  return {
    name,
    call<K extends keyof typeof operations>(
      op: K,
      ...args: Parameters<(typeof operations)[K]>
    ) {
      return new Promise<Awaited<ReturnType<(typeof operations)[K]>>>(
        (resolve, reject) => {
          const id = nextId++;
          pending.set(id, {
            resolve: resolve as (value: unknown) => void,
            reject,
          });
          worker.postMessage({ id, op, args });
        },
      );
    },
    terminate() {
      worker.terminate();
    },
    async close() {
      try {
        await this.call("close");
      } finally {
        worker.terminate();
      }
    },
  };
}
