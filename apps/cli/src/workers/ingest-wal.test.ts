import { expect, test } from "bun:test";
import { sameIngestWal } from "./ingest-jobs.js";
import type { IngestIdentity } from "./ingestTypes.js";

const wal: IngestIdentity = {
  dev: 1,
  ino: 2,
  birthtimeMs: 3,
  ctimeMs: 4,
  mtimeMs: 5,
  size: 12_392,
};

test("a change to WAL status metadata alone does not invalidate the read", () => {
  expect(sameIngestWal(wal, { ...wal, ctimeMs: 6 })).toBe(true);
});

test("a same-size WAL write invalidates the read", () => {
  expect(sameIngestWal(wal, { ...wal, mtimeMs: 6 })).toBe(false);
});

test("a WAL resize, replacement, creation or removal invalidates the read", () => {
  expect(sameIngestWal(wal, { ...wal, size: 0 })).toBe(false);
  expect(sameIngestWal(wal, { ...wal, ino: 7 })).toBe(false);
  expect(sameIngestWal(null, wal)).toBe(false);
  expect(sameIngestWal(wal, null)).toBe(false);
  expect(sameIngestWal(null, null)).toBe(true);
});
