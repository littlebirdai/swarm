import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { loadScaledMs } from "../test-helpers/machineLoad.js";
import { pollUntil } from "../test-helpers/pollUntil.js";
import { closeDaemonWorkers, configureDaemonWorkers } from "./bridge.js";
import { WorkerOperationError, WorkerUnavailable } from "./host.js";
import {
  IngestCancelled,
  IngestCapacityError,
  IngestDeadlineExceeded,
  readTranscriptIngest,
} from "./ingest-client.js";
import { IngestCursors } from "./ingestCursors.js";
import type { IngestPayload } from "./ingestTypes.js";
import {
  encodeFrame,
  FrameDecoder,
  MAX_INFLIGHT,
  MAX_QUEUE,
} from "./protocol.js";

type Input = Parameters<typeof readTranscriptIngest>[0];
type Read = ReturnType<typeof readTranscriptIngest>;
type Open = { id: string; payload: Extract<IngestPayload, { action: "open" }> };

let root: string;
const inflight: Read[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ingest-admission-"));
});

afterEach(async () => {
  closeDaemonWorkers();
  await Promise.allSettled(inflight.splice(0));
  await rm(root, { recursive: true, force: true });
});

function read(
  input: Input,
  options?: Parameters<typeof readTranscriptIngest>[1],
) {
  const run = readTranscriptIngest(input, options);
  void run.catch(() => {});
  inflight.push(run);
  return run;
}

function interceptStat(
  observe: (
    file: fs.PathLike,
    stat: () => Promise<unknown>,
  ) => Promise<unknown>,
) {
  const original = fs.promises.stat;
  return spyOn(fs.promises, "stat").mockImplementation(
    new Proxy(original, {
      apply(target, receiver, args: Parameters<typeof original>) {
        return observe(args[0], () => Reflect.apply(target, receiver, args));
      },
    }),
  );
}

function row(id: string) {
  return (
    JSON.stringify({
      type: "assistant",
      uuid: id,
      timestamp: "2026-09-05T00:00:00Z",
      message: { role: "assistant", content: id },
    }) + "\n"
  );
}

async function transcript(id: string): Promise<Input> {
  const file = path.join(root, id + ".jsonl");
  await writeFile(file, row(id));
  return {
    client: "claude",
    sessionId: id,
    file,
    offset: 0,
    recoverBackup: true,
  };
}

async function controlledWorker(hold: (id: string) => boolean = () => false) {
  const input = new PassThrough();
  const output = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    pid: 900001,
    stdin: input,
    stdout: output,
    stderr: new PassThrough(),
  });
  const cursors = new IngestCursors();
  const decoder = new FrameDecoder();
  const opens: Open[] = [];
  const refuse = (id: string) =>
    output.write(
      encodeFrame({
        v: 1,
        kind: "ingest",
        type: "error",
        id,
        error: "operation_failed",
      }),
    );
  const reply = async (id: string, payload: IngestPayload) => {
    try {
      const result = await cursors.request(payload, id);
      output.write(
        encodeFrame({
          v: 1,
          kind: "ingest",
          type: "result",
          id,
          operation: "ingest",
          result,
        }),
      );
    } catch {
      refuse(id);
    }
  };
  input.on("data", (part: Buffer) => {
    for (const frame of decoder.push(part)) {
      if (frame.type !== "request" || frame.operation !== "ingest")
        throw new Error("unexpected ingest frame");
      const payload = frame.payload as IngestPayload;
      if (payload.action === "open") {
        opens.push({ id: frame.id!, payload });
        if (hold(payload.job.sessionId)) continue;
      }
      void reply(frame.id!, payload);
    }
  });
  await configureDaemonWorkers(
    true,
    {},
    {},
    {
      invocation: { command: "controlled-worker", args: [] },
      spawnChild: () => child as unknown as ChildProcess,
      killChild: () => {},
    },
  );
  return {
    opens,
    release: (index: number) => reply(opens[index].id, opens[index].payload),
    refuse: (index: number) => refuse(opens[index].id),
    crash: () => child.emit("exit", 1),
  };
}

async function fullWorker() {
  const worker = await controlledWorker((id) => id.startsWith("held-"));
  const inputs = await Promise.all(
    Array.from({ length: MAX_INFLIGHT }, (_, index) =>
      transcript(`held-${index}`),
    ),
  );
  const held = inputs.map((input) => read(input));
  await pollUntil(
    () => worker.opens.length === MAX_INFLIGHT,
    "all cursor slots occupied",
  );
  return {
    ...worker,
    held,
    releaseAll: () =>
      Promise.all(held.map((_, index) => worker.release(index))),
  };
}

test(
  "a transcript that grows in the queue is read through its new end",
  async () => {
    const worker = await fullWorker();
    const input = await transcript("growing");
    let initial: Promise<unknown> | undefined;
    const stat = interceptStat((file, readStat) => {
      const result = readStat();
      if (file === input.file) initial ??= result;
      return result;
    });
    try {
      const result = read(input);
      await initial;
      const extra = row("appended");
      await appendFile(input.file, extra);
      await worker.release(0);
      const ingested = await result;
      expect(ingested.messages.map(({ uuid }) => uuid)).toEqual([
        "growing",
        "appended",
      ]);
      expect(ingested.bytesConsumed).toBe(
        Buffer.byteLength(row("growing") + extra),
      );
    } finally {
      stat.mockRestore();
    }
  },
  loadScaledMs(8_000),
);

test(
  "the first queued transcript gets the next slot even when its stat is slow",
  async () => {
    const worker = await fullWorker();
    const first = await transcript("first");
    const second = await transcript("second");
    const allowFirstStat = Promise.withResolvers<void>();
    const statCalls: string[] = [];
    const stat = interceptStat(async (file, readStat) => {
      if (file === first.file) {
        statCalls.push("first");
        await allowFirstStat.promise;
      } else if (file === second.file) statCalls.push("second");
      return readStat();
    });
    try {
      const requested = [read(first), read(second)];
      await worker.release(0);
      await pollUntil(
        () => statCalls.length > 0,
        "first queued identity begins",
      );
      expect(statCalls).toEqual(["first"]);
      allowFirstStat.resolve();
      await Promise.all(requested);
      expect(
        worker.opens
          .slice(MAX_INFLIGHT)
          .map(({ payload }) => payload.job.sessionId),
      ).toEqual(["first", "second"]);
    } finally {
      allowFirstStat.resolve();
      stat.mockRestore();
    }
  },
  loadScaledMs(8_000),
);

for (const reason of ["cancel", "timeout"] as const)
  test(
    `${reason} removes all four queued waiters before they read any identity`,
    async () => {
      const worker = await fullWorker();
      const retired = await Promise.all(
        Array.from({ length: MAX_INFLIGHT }, (_, i) =>
          transcript(`retired-${i}`),
        ),
      );
      const fresh = await transcript("fresh");
      const controller = new AbortController();
      const retiredFiles = new Set(retired.map(({ file }) => file));
      const hits: string[] = [];
      const stat = interceptStat((file, readStat) => {
        if (typeof file === "string" && retiredFiles.has(file)) hits.push(file);
        return readStat();
      });
      try {
        const waiting = retired.map((input) =>
          read(
            input,
            reason === "cancel"
              ? { signal: controller.signal }
              : { timeoutMs: 25 },
          ),
        );
        if (reason === "cancel") controller.abort();
        const expected =
          reason === "cancel" ? IngestCancelled : IngestDeadlineExceeded;
        const outcomes = await Promise.allSettled(waiting);
        expect(outcomes).toHaveLength(MAX_INFLIGHT);
        expect(
          outcomes.every(
            (outcome) =>
              outcome.status === "rejected" &&
              outcome.reason instanceof expected,
          ),
        ).toBe(true);
        expect(hits).toEqual([]);

        const replacements = Array.from({ length: MAX_QUEUE }, () =>
          read(fresh, { timeoutMs: loadScaledMs(2_000) }),
        );
        await worker.releaseAll();
        const results = await Promise.allSettled(replacements);
        expect(
          results.flatMap((result) =>
            result.status === "rejected" ? [String(result.reason)] : [],
          ),
        ).toEqual([]);
        expect(
          worker.opens
            .slice(MAX_INFLIGHT)
            .map(({ payload }) => payload.job.sessionId),
        ).toEqual(Array.from({ length: MAX_QUEUE }, () => fresh.sessionId));
      } finally {
        stat.mockRestore();
      }
    },
    loadScaledMs(8_000),
  );

test(
  "the first read past the cursor and waiter limits rejects for capacity",
  async () => {
    const worker = await fullWorker();
    const input = await transcript("waiting");
    const waiting = Array.from({ length: MAX_QUEUE }, () =>
      read(input, { timeoutMs: loadScaledMs(2_000) }),
    );
    const excess = read(input, { timeoutMs: loadScaledMs(100) });
    const [overflow] = await Promise.allSettled([excess]);
    expect(overflow.status).toBe("rejected");
    if (overflow.status === "rejected")
      expect(overflow.reason).toBeInstanceOf(IngestCapacityError);
    await worker.releaseAll();
    expect(
      (await Promise.all(waiting)).map(({ bytesConsumed }) => bytesConsumed),
    ).toEqual(
      Array.from({ length: MAX_QUEUE }, () =>
        Buffer.byteLength(row("waiting")),
      ),
    );
  },
  loadScaledMs(8_000),
);

for (const failure of ["error", "crash", "shutdown"] as const)
  test(
    `four occupied cursor slots recover after worker ${failure}`,
    async () => {
      const worker = await fullWorker();
      const result = Promise.allSettled(worker.held);
      if (failure === "error")
        worker.held.forEach((_, index) => worker.refuse(index));
      else if (failure === "crash") worker.crash();
      else closeDaemonWorkers();
      const expected =
        failure === "error"
          ? WorkerOperationError
          : failure === "crash"
            ? WorkerUnavailable
            : IngestCancelled;
      expect(
        (await result).every(
          (row) => row.status === "rejected" && row.reason instanceof expected,
        ),
      ).toBe(true);

      const restarted = await controlledWorker();
      const input = await transcript("successor");
      const next = await Promise.allSettled(
        Array.from({ length: MAX_INFLIGHT }, () =>
          read(input, { timeoutMs: loadScaledMs(1_000) }),
        ),
      );
      expect(
        next.flatMap((result) =>
          result.status === "rejected" ? [String(result.reason)] : [],
        ),
      ).toEqual([]);
      expect(restarted.opens).toHaveLength(MAX_INFLIGHT);
    },
    loadScaledMs(8_000),
  );
