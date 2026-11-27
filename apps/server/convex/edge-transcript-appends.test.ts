import { afterEach, beforeEach, expect, test } from "bun:test";
import { setupRunLease } from "../test-helpers/run-lease.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import { api } from "./_generated/api";

const flag = "CODECAST_EDGE_TRANSCRIPT_UPLINK_V1";
const previous = process.env[flag];

beforeEach(() => {
  process.env[flag] = "1";
});
afterEach(() => {
  if (previous === undefined) delete process.env[flag];
  else process.env[flag] = previous;
});

async function setup() {
  const { t, owner, conversation, bearer, wrongDevice, unbound } =
    await setupRunLease();
  const [second, foreign] = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "transcript append sessions");
    return [
      await rows.conversation(owner),
      await rows.conversation(await rows.user()),
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
  const append = (body = batch, token = bearer) =>
    t.fetch("/edge/v1/transcripts.append", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  return { t, batch, append, conversation, bearer, wrongDevice, unbound };
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

test("the flag disables the edge route while the legacy writer still works", async () => {
  const { t, batch, append, conversation, bearer } = await setup();
  delete process.env[flag];
  expect((await append()).status).toBe(404);
  const result = await t.mutation(api.messages.addMessages, {
    conversation_id: conversation,
    api_token: bearer,
    messages: batch.writes[0]!.messages,
  });
  expect(result.inserted).toBe(1);
});
