import { expect } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join as joinPath } from "node:path";
import { tmpdir } from "node:os";
import {
  TRANSCRIPT_APPEND_MAX_BYTES,
  type TranscriptAppendRequest,
} from "@codecast/edge-contract";
import { it } from "@codecast/effect-kit/effect/testing";
import * as Effect from "effect/Effect";
import { join } from "effect/Fiber";
import * as Metric from "effect/Metric";
import { adjust } from "effect/testing/TestClock";
import { fileTranscriptSpool, TranscriptUplink } from "../src/effect";

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

const ack = (batch: TranscriptAppendRequest) => ({
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
          yield* uplink.ready;
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
