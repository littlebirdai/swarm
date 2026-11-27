import { expect } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join as joinPath } from "node:path";
import { tmpdir } from "node:os";
import {
  TRANSCRIPT_APPEND_MAX_BYTES,
  type TranscriptAppendReceipt,
  type TranscriptAppendRequest,
  type TranscriptAppendWrite,
} from "@codecast/edge-contract";
import { it } from "@codecast/effect-kit/effect/testing";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { join } from "effect/Fiber";
import * as Metric from "effect/Metric";
import { adjust } from "effect/testing/TestClock";
import {
  fileTranscriptSpool,
  TranscriptUplink,
  TranscriptUplinkError,
} from "../src/effect";

for (const recovers of [true, false]) {
  it.effect(
    recovers
      ? "transient spool reads recover on spaced retries"
      : "transient startup reads stop after three retries",
    () => {
      const path = "/fixture/spool.json";
      const cause = Object.assign(new Error("device is unavailable"), {
        code: "EIO",
      });
      let reads = 0;
      return Effect.gen(function* () {
        const uplink = yield* TranscriptUplink;
        const ready = yield* Effect.forkChild(Effect.result(uplink.ready));
        yield* adjust(0);
        expect(reads).toBe(1);
        for (const attempt of [2, 3, 4]) {
          yield* adjust(999);
          expect(reads).toBe(attempt - 1);
          yield* adjust(1);
          expect(reads).toBe(attempt);
        }
        yield* adjust(10_000);
        expect(reads).toBe(4);
        const result = yield* join(ready);
        if (recovers) expect(result._tag).toBe("Success");
        else {
          expect(result).toMatchObject({
            _tag: "Failure",
            failure: { cause, spoolPath: path, retryable: false },
          });
          if (result._tag === "Failure") {
            expect(result.failure.message).toContain(path);
            expect(result.failure.message).toContain("EIO");
          }
        }
      }).pipe(
        Effect.provide(
          TranscriptUplink.layer({
            spool: {
              path,
              async read() {
                reads++;
                if (recovers && reads === 4) return null;
                throw cause;
              },
              async save() {
                throw new Error("Unexpected spool save");
              },
              async clear() {
                throw new Error("Unexpected spool clear");
              },
            },
            async send() {
              throw new Error("Unexpected edge request");
            },
          }),
        ),
      );
    },
  );
}

const retained: TranscriptAppendRequest = {
  v: 1,
  batch_id: "retained",
  writes: [
    {
      conversation_id: "held",
      messages: [{ role: "assistant", message_uuid: "previous" }],
    },
  ],
};

const ack = (batch: TranscriptAppendRequest): TranscriptAppendReceipt => ({
  v: 1,
  batch_id: batch.batch_id,
  results: batch.writes.map(() => ({
    status: "applied",
    inserted: 1,
    ids: ["ack"],
  })),
});

for (const [kind, bytes] of [
  ["corrupt JSON", Buffer.from("{corrupt json")],
  ["invalid UTF-8", Buffer.from([0xc0, 0xaf])],
  ["oversized", Buffer.alloc(TRANSCRIPT_APPEND_MAX_BYTES + 1, 65)],
] as const) {
  it.effect(`quarantines ${kind} bytes and resumes uploads`, () =>
    Effect.gen(function* () {
      const dir = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(joinPath(tmpdir(), "uplink-quarantine-"))),
        (path) =>
          Effect.promise(() => rm(path, { recursive: true, force: true })),
      );
      const path = joinPath(dir, "spool.json");
      yield* Effect.promise(() => writeFile(path, bytes));
      yield* Effect.gen(function* () {
        const uplink = yield* TranscriptUplink;
        yield* uplink.ready;
        const names = yield* Effect.promise(() => readdir(dir));
        expect(names).toHaveLength(1);
        expect(names[0]).toStartWith("spool.json.quarantine-");
        expect(
          yield* Effect.promise(() => readFile(joinPath(dir, names[0]!))),
        ).toEqual(bytes);
        expect(
          (yield* Metric.value(
            Metric.counter("transcript_uplink_quarantined_spools"),
          )).count,
        ).toBe(1);
        const pending = yield* Effect.forkChild(
          uplink.submit(retained.writes[0]!),
        );
        yield* adjust(250);
        expect(yield* join(pending)).toMatchObject({ status: "applied" });
        expect(yield* Effect.promise(() => readdir(dir))).toEqual(names);
      }).pipe(
        Effect.provide(
          TranscriptUplink.layer({
            spool: fileTranscriptSpool(path),
            send: async (batch) => ack(batch),
          }),
        ),
      );
    }).pipe(Effect.provideService(Metric.MetricRegistry, new Map())),
  );
}

for (const failsClear of [false, true]) {
  it.effect(
    `startup retries a readable spool after a permanent ${failsClear ? "clear" : "receipt"} error`,
    () =>
      Effect.gen(function* () {
        const sent: TranscriptAppendRequest[] = [];
        let clears = 0;
        yield* Effect.gen(function* () {
          const uplink = yield* TranscriptUplink;
          yield* adjust(0);
          expect(sent).toEqual([retained]);
          const startupError = yield* Effect.flip(uplink.ready);
          expect(startupError.message).toContain(
            failsClear
              ? "spool clear failed"
              : "Invalid transcript batch receipt",
          );
          expect(startupError.message).toContain("held");
          expect(
            (yield* Effect.flip(uplink.waitForReplay("held"))).message,
          ).toContain(
            failsClear
              ? "spool clear failed"
              : "Invalid transcript batch receipt",
          );
          expect(
            yield* uplink.submit({
              ...retained.writes[0]!,
              conversation_id: "unrelated",
            }),
          ).toEqual({ status: "legacy" });
          yield* adjust(29_999);
          expect(sent).toHaveLength(1);
          expect(clears).toBe(failsClear ? 1 : 0);
          yield* adjust(1);
          expect(sent).toEqual(failsClear ? [retained] : [retained, retained]);
          expect(clears).toBe(failsClear ? 2 : 1);
          yield* uplink.waitForReplay("held");
        }).pipe(
          Effect.provide(
            TranscriptUplink.layer({
              spool: {
                read: async () => retained,
                async clear() {
                  if (++clears === 1 && failsClear)
                    throw new Error("fsync failed");
                },
                async save() {
                  throw new Error("Unexpected new batch");
                },
              },
              async send(batch) {
                sent.push(batch);
                return ack(
                  !failsClear && sent.length === 1
                    ? { ...batch, batch_id: "wrong" }
                    : batch,
                );
              },
              async fallback() {
                throw new Error("The caller owns the legacy write");
              },
            }),
          ),
        );
      }),
  );
}

it.effect(
  "a readable but incompatible spool stays in place across startup failure",
  () =>
    Effect.gen(function* () {
      const dir = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(joinPath(tmpdir(), "uplink-schema-"))),
        (path) =>
          Effect.promise(() => rm(path, { recursive: true, force: true })),
      );
      const path = joinPath(dir, "spool.json");
      const bytes = JSON.stringify({ ...retained, v: 99 });
      yield* Effect.promise(() => writeFile(path, bytes));
      yield* Effect.gen(function* () {
        const uplink = yield* TranscriptUplink;
        const failure = yield* Effect.flip(uplink.ready);
        expect(failure).toMatchObject({
          startupReadFailure: true,
          spoolPath: path,
        });
        expect(yield* Effect.promise(() => readdir(dir))).toEqual([
          "spool.json",
        ]);
        expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe(bytes);
      }).pipe(
        Effect.provide(
          TranscriptUplink.layer({
            spool: fileTranscriptSpool(path),
            async send() {
              throw new Error("Unexpected edge request");
            },
          }),
        ),
      );
    }),
);

it.effect(
  "a malformed packet from an older daemon skips the edge and clears after ordered fallback",
  () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() =>
          mkdtemp(joinPath(tmpdir(), "transcript-old-spool-")),
        ),
        (path) =>
          Effect.promise(() => rm(path, { recursive: true, force: true })),
      );
      const spool = fileTranscriptSpool(joinPath(directory, "spool.json"));
      const rejected: TranscriptAppendWrite = {
        conversation_id: "bad",
        messages: [{ role: "assistant", message_uuid: "old-bad", content: 42 }],
      };
      const good: TranscriptAppendWrite = {
        conversation_id: "good",
        messages: [
          { role: "assistant", message_uuid: "old-good", content: "valid" },
        ],
      };
      yield* Effect.promise(() =>
        spool.save({ v: 1, batch_id: "previous", writes: [rejected, good] }),
      );
      const legacy: string[] = [];
      yield* Effect.flatMap(TranscriptUplink, (uplink) => uplink.ready).pipe(
        Effect.provide(
          TranscriptUplink.layer({
            spool,
            async send() {
              throw new TranscriptUplinkError({
                message: "malformed batch reached the edge",
                retryable: false,
              });
            },
            async fallback(write) {
              legacy.push(write.conversation_id);
              return write.conversation_id === "bad"
                ? { status: "refused" }
                : { status: "applied", inserted: 1, ids: ["good"] };
            },
          }),
        ),
      );
      expect(legacy).toEqual(["bad", "good"]);
      expect(yield* Effect.promise(spool.read)).toBeNull();
    }),
);

it.effect("the disk spool caps both saves and reads before decoding", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() =>
        mkdtemp(joinPath(tmpdir(), "transcript-spool-limit-")),
      ),
      (path) =>
        Effect.promise(() => rm(path, { recursive: true, force: true })),
    );
    const path = joinPath(directory, "spool.json");
    const spool = fileTranscriptSpool(path);
    const batch: TranscriptAppendRequest = {
      v: 1,
      batch_id: "large",
      writes: [
        {
          conversation_id: "large",
          messages: [
            {
              role: "assistant",
              content: "é".repeat(TRANSCRIPT_APPEND_MAX_BYTES / 2),
            },
          ],
        },
      ],
    };
    const saveFailure = yield* Effect.flip(
      Effect.tryPromise(() => spool.save(batch)),
    );
    expect(saveFailure.cause).toEqual(
      new Error("Transcript spool exceeds byte limit"),
    );
    expect(yield* Effect.promise(spool.read)).toBeNull();
    yield* Effect.promise(() => writeFile(path, JSON.stringify(batch)));
    const readFailure = yield* Effect.flip(Effect.tryPromise(spool.read));
    expect(readFailure.cause).toEqual(
      new Error("Transcript spool exceeds byte limit"),
    );
  }),
);

it.effect(
  "an unreadable startup spool fails both waiting and later writes closed",
  () =>
    Effect.gen(function* () {
      const failRead = yield* Deferred.make<void>();
      let sends = 0;
      yield* Effect.flatMap(TranscriptUplink, (uplink) =>
        Effect.gen(function* () {
          const waiting = yield* Effect.forkChild(
            Effect.result(
              uplink.submit({
                conversation_id: "possibly-spooled",
                messages: [{ role: "assistant", content: "possibly-spooled" }],
              }),
            ),
          );
          yield* adjust(0);
          yield* Deferred.succeed(failRead, undefined);
          const error = yield* Effect.flip(uplink.ready);
          expect(error.message).toContain("Transcript spool read failed");
          expect(yield* join(waiting)).toMatchObject({
            _tag: "Failure",
            failure: error,
          });
          expect(
            yield* Effect.result(
              uplink.submit({
                conversation_id: "new",
                messages: [{ role: "assistant", content: "new" }],
              }),
            ),
          ).toMatchObject({ _tag: "Failure", failure: error });
          expect(yield* Effect.flip(uplink.waitForReplay("new"))).toBe(error);
          expect(sends).toBe(0);
        }),
      ).pipe(
        Effect.provide(
          TranscriptUplink.layer({
            spool: {
              read: async () => {
                await Effect.runPromise(Deferred.await(failRead));
                throw new Error("spool unreadable");
              },
              save: async () => {},
              clear: async () => {},
            },
            async send(batch): Promise<TranscriptAppendReceipt> {
              sends++;
              return ack(batch);
            },
            async fallback() {
              return { status: "refused" };
            },
          }),
        ),
      );
    }),
);
