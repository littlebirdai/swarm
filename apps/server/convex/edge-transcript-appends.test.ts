import { getFunctionName } from "convex/server";
import crons from "./crons";
import { afterEach, expect, setSystemTime, test } from "bun:test";
import { setupRunLease } from "../test-helpers/run-lease.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import { scheduledJobs } from "../test-helpers/database.testkit";
import { TRANSCRIPT_RECEIPT_RETENTION_MS } from "./lib/edge/transcript-appends.route";
import { api, internal } from "./_generated/api";

afterEach(() => {
  setSystemTime();
});

async function setup() {
  const { t, owner, conversation, bearer, wrongDevice, unbound } =
    await setupRunLease();
  const [second, foreign, hosted] = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "transcript append sessions");
    return [
      await rows.conversation(owner),
      await rows.conversation(await rows.user()),
      await rows.conversation(owner, { agent_type: "codecast" }),
    ];
  });
  const makeWrite = (conversation_id: string, content: string) => ({
    conversation_id,
    messages: [{ role: "assistant" as const, content, timestamp: 10 }],
  });
  const batch = {
    v: 1,
    batch_id: "daemon-batch",
    writes: [
      makeWrite(conversation, "first"),
      makeWrite(foreign, "foreign"),
      makeWrite(second, "second"),
    ],
  };
  const append = (body: unknown = batch, token = bearer) =>
    t.fetch("/edge/v1/transcripts.append", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  return {
    t,
    batch,
    append,
    conversation,
    bearer,
    wrongDevice,
    unbound,
    hosted,
  };
}

test("accepts a machine batch across sessions and refuses only the foreign session", async () => {
  const { t, batch, append } = await setup();
  const first = await append();
  expect(first.status).toBe(200);
  const receipt = await first.json();
  expect(receipt).toEqual({
    v: 1,
    batch_id: batch.batch_id,
    results: [
      { status: "applied", inserted: 1, ids: [expect.any(String)] },
      { status: "refused" },
      { status: "applied", inserted: 1, ids: [expect.any(String)] },
    ],
  });
  const replay = await append();
  expect(await replay.json()).toEqual(receipt);
  const rows = await t.run(async ({ db }) => db.query("messages").collect());
  expect(rows.map((row) => row.content).sort()).toEqual(["first", "second"]);

  const changed = { ...batch, writes: [batch.writes[0]!] };
  expect((await append(changed)).status).toBe(409);
});

test("receipts are device scoped and the route requires a device bearer", async () => {
  const { append, batch, wrongDevice, unbound } = await setup();
  expect((await append(batch, unbound)).status).toBe(401);
  const first = await append();
  expect(first.status).toBe(200);
  const second = await append(
    { ...batch, writes: [batch.writes[0]!] },
    wrongDevice,
  );
  expect(second.status).toBe(200);
  expect((await second.json()).results).toHaveLength(1);
});

test("refuses a hosted session even for its owner", async () => {
  const { t, append, batch, hosted } = await setup();
  const response = await append({
    ...batch,
    writes: [{ ...batch.writes[0], conversation_id: hosted }],
  });
  expect(await response.json()).toMatchObject({
    results: [{ status: "refused" }],
  });
  expect(await t.run(({ db }) => db.query("messages").collect())).toEqual([]);
});

test("malformed messages and invalid storage ids get a non-retryable 400", async () => {
  const { t, append, batch } = await setup();
  for (const messages of [
    [{ role: "assistant", content: 42 }],
    [
      {
        role: "assistant",
        images: [{ media_type: "image/png", storage_id: "not-a-storage-id" }],
      },
    ],
  ]) {
    const response = await append({
      ...batch,
      writes: [{ ...batch.writes[0], messages }],
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      status: "error",
      retryable: false,
    });
  }
  expect(
    await t.run(({ db }) => db.query("edge_transcript_receipts").collect()),
  ).toEqual([]);
});

test("receipt retention prunes one bounded page and preserves an unexpired receipt", async () => {
  expect(crons.crons["prune transcript receipts"]).toMatchObject({
    name: getFunctionName(internal.edgeLink.pruneTranscriptReceipts),
    schedule: { type: "interval", minutes: 10 },
  });
  const now = 1_790_000_000_000;
  setSystemTime(new Date(now));
  const { t, append } = await setup();
  expect((await append()).status).toBe(200);
  const [receipt] = await t.run(({ db }) =>
    db.query("edge_transcript_receipts").collect(),
  );
  expect(receipt?.retain_until).toBe(now + TRANSCRIPT_RECEIPT_RETENTION_MS);
  await t.run(async ({ db }) => {
    const { _id: _receiptId, _creationTime: _created, ...row } = receipt!;
    for (let index = 0; index < 501; index++)
      await db.insert("edge_transcript_receipts", {
        ...row,
        batch_id: `expired-${index}`,
        retain_until: now,
      });
    await db.insert("edge_transcript_receipts", {
      ...row,
      batch_id: "old-schema",
      retain_until: undefined,
    });
  });
  expect(await t.mutation(internal.edgeLink.pruneTranscriptReceipts, {})).toBe(
    499,
  );
  const left = await t.run(({ db }) =>
    db.query("edge_transcript_receipts").collect(),
  );
  expect(
    left.filter(({ batch_id }) => batch_id.startsWith("expired-")),
  ).toHaveLength(2);
  const old = left.find(({ batch_id }) => batch_id === "old-schema")!;
  expect(old.retain_until).toBe(
    old._creationTime + TRANSCRIPT_RECEIPT_RETENTION_MS,
  );
  expect(left.some(({ _id }) => _id === receipt?._id)).toBe(true);
  expect(
    await scheduledJobs(t, internal.edgeLink.pruneTranscriptReceipts),
  ).toHaveLength(1);
  setSystemTime(new Date(Math.ceil(old.retain_until!)));
  expect(await t.mutation(internal.edgeLink.pruneTranscriptReceipts, {})).toBe(
    4,
  );
});
