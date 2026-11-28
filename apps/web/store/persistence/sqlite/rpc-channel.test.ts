import { expect, test } from "bun:test";
import type { CacheEpoch, WorkerHandle } from "./protocol";
import { createRpcChannelManager } from "./rpc-channel";

const epoch = (generation: number): CacheEpoch => ({
  schemaVersion: 116,
  accountEpoch: 1,
  generation,
  principal: "userA",
  updatedAt: generation,
});

function manager(timeoutMs = 20) {
  const state = {
    closed: false,
    disabled: false,
    activeEpoch: epoch(1) as CacheEpoch | null,
    ownedWorker: { postMessage() {}, terminate() {} } as WorkerHandle | null,
    ownedWorkerId: "w-1" as string | null,
    ownedWorkerReady: true,
    knownWorkerId: "w-1" as string | null,
    sharedChannel: null,
  };
  const timeouts: CacheEpoch[] = [];
  const lost: string[] = [];
  const rpc = createRpcChannelManager({
    clientId: "client",
    channelTransport: null,
    workerTimeoutMs: timeoutMs,
    now: () => Date.now(),
    getState: () => state,
    clearKnownWorker: () => {
      state.knownWorkerId = null;
    },
    onTimeout: (timedOut) => timeouts.push(timedOut),
    onWriteLost: (_epoch, reason) => lost.push(reason),
  });
  return { rpc, state, timeouts, lost };
}

test("a timeout of a request for an epoch that is no longer active rotates nothing", async () => {
  const { rpc, state, timeouts } = manager();
  const request = rpc.enqueueAndDispatch({
    epoch: epoch(1),
    principal: "userA",
    op: "ping",
    payload: {},
    reqId: "r1",
    deadline: Date.now() + 20,
  });
  state.activeEpoch = epoch(2);

  await expect(request).rejects.toThrow("timed out");
  expect(timeouts).toEqual([]);
});

test("a timeout of a request for the active epoch rotates it", async () => {
  const { rpc, timeouts } = manager();
  const request = rpc.enqueueAndDispatch({
    epoch: epoch(1),
    principal: "userA",
    op: "ping",
    payload: {},
    reqId: "r1",
    deadline: Date.now() + 20,
  });

  await expect(request).rejects.toThrow("timed out");
  expect(timeouts.map((timedOut) => timedOut.generation)).toEqual([1]);
});

test("a write lost to a replaced worker is reported before its promise settles", async () => {
  const { rpc, lost } = manager(5000);
  const write = rpc.enqueueAndDispatch({
    epoch: epoch(1),
    principal: "userA",
    op: "flushBatch",
    payload: {},
    reqId: "w1",
    deadline: Date.now() + 5000,
  });
  const settled = write.catch(() => "rejected");
  rpc.redispatchForWorkerChange("v116-a1-g1", "w-2");

  expect(lost).toEqual(["Worker replaced during write"]);
  expect(await settled).toBe("rejected");
});
