import { afterEach, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { pollUntil } from "../test-helpers/pollUntil.js";
import {
  closeDaemonWorkers,
  configureDaemonWorkers,
  routeProbe,
} from "./bridge.js";
import { encodeFrame, type WorkerFrame } from "./protocol.js";

afterEach(closeDaemonWorkers);

function childFixture() {
  const inbox: WorkerFrame[] = [];
  const child = Object.assign(new EventEmitter(), {
    pid: 900001,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  child.stdin.on("data", (chunk) => inbox.push(JSON.parse(chunk.toString())));
  const respond = (index: number, stdout: string) =>
    child.stdout.write(
      encodeFrame({
        v: 1,
        kind: "probe",
        type: "result",
        id: inbox[index].id,
        operation: "read",
        result: { status: 0, signal: null, killed: false, stdout, stderr: "" },
      }),
    );
  return {
    inbox,
    respond,
    options: {
      invocation: { command: "owned-fixture", args: [] },
      spawnChild: () => child as unknown as ChildProcess,
      killChild: () => {},
    },
  };
}

test("out-of-order worker replies reach the caller that owns each request", async () => {
  const child = childFixture();
  await configureDaemonWorkers(true, child.options);
  const noFallback = async (): Promise<{ stdout: string; stderr: string }> => {
    throw new Error("unexpected fallback");
  };
  const first = routeProbe("ps", ["aux"], { timeout: 5000 }, noFallback);
  const second = routeProbe("ps", ["aux"], { timeout: 5000 }, noFallback);
  const delivered = Promise.allSettled([first, second]);
  await pollUntil(() => child.inbox.length === 2, "both requests reach worker");
  child.respond(1, "second");
  expect(await Promise.race([first, second])).toEqual({
    stdout: "second",
    stderr: "",
  });
  child.respond(0, "first");
  expect(await delivered).toEqual([
    { status: "fulfilled", value: { stdout: "first", stderr: "" } },
    { status: "fulfilled", value: { stdout: "second", stderr: "" } },
  ]);
});

test("a slow-start worker result cannot be accepted past its request deadline", async () => {
  const child = childFixture();
  let wall = Date.now();
  let mono = 0;
  const host = await configureDaemonWorkers(true, {
    ...child.options,
    clock: { wall: () => wall, mono: () => mono },
  });
  const read = host!.request(
    "read",
    { operation: "ps", args: ["aux"], options: {} },
    { timeoutMs: 5000 },
  );
  const outcome = Promise.allSettled([read]);
  await pollUntil(
    () => child.inbox.length === 1,
    "request reaches slow-start worker",
  );
  wall += 5000;
  mono += 5000;
  child.respond(0, "late");
  const [result] = await outcome;
  expect(result.status).toBe("rejected");
  if (result.status === "rejected")
    expect(result.reason.message).toBe("worker deadline");
  expect(host!.state.pid).toBeNull();
  expect(host!.state.pending).toBe(0);
});

test("a worker spawn refused with EMFILE settles the read through the local path", async () => {
  let starts = 0;
  let localReads = 0;
  const host = await configureDaemonWorkers(true, {
    invocation: { command: "owned-fixture", args: [] },
    spawnChild() {
      starts++;
      throw Object.assign(new Error("file descriptor limit"), {
        code: "EMFILE",
      });
    },
    clock: { wall: Date.now, mono: () => 0 },
  });
  const fallback = async () => {
    localReads++;
    return { stdout: "local", stderr: "" };
  };
  for (let i = 0; i < 2; i++)
    await expect(
      routeProbe("ps", ["aux"], { timeout: 5000 }, fallback),
    ).resolves.toEqual({ stdout: "local", stderr: "" });
  expect(starts).toBe(1);
  expect(localReads).toBe(2);
  expect(host!.state).toMatchObject({ pid: null, pending: 0 });
});
