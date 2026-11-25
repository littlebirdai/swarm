import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { hashToken } from "./apiTokens";
import schema from "./schema";
import { allModules } from "./testModules.testkit";

const apiToken = "expectations-test-token";
const citation = { kind: "commit", ref: "seed" } as const;
const text = "Show the caller's name.";
const lineId = "ex-calls-1";

async function fixture(documentsRead?: number) {
  const t = convexTest({
    schema,
    modules: allModules,
    transactionLimits: documentsRead === undefined ? false : { documentsRead },
  });
  const seed = await t.run(async ({ db }) => {
    const user = await db.insert("users", { name: "Owner" });
    const workspace = `user:${user}`;
    const project = await db.insert("projects", {
      user_id: user,
      workspace,
      title: "Calls",
      status: "active",
      created_at: 1,
      updated_at: 1,
    });
    await db.insert("api_tokens", {
      user_id: user,
      token_hash: await hashToken(apiToken),
      name: "Expectations test",
      created_at: 1,
      last_used_at: 1,
    });
    return { user, workspace, project };
  });
  const owner = t.withIdentity({ subject: `${seed.user}|test` });
  const writeVersion = (
    version: number,
    overrides: Partial<Doc<"project_expectations">["items"][number]> = {},
  ) =>
    t.run(({ db }) =>
      db.insert("project_expectations", {
        project_id: seed.project,
        user_id: seed.user,
        workspace: seed.workspace,
        version,
        prefix: "calls",
        next_n: 2,
        items: [
          {
            id: lineId,
            text,
            part: "Calls",
            status: "active",
            citations: [citation],
            added_in: 1,
            changed_in: version,
            ...overrides,
          },
        ],
        summary: "Caller name",
        how: "person",
        created_at: version,
      }),
    );
  const propose = (op: Doc<"expectation_proposals">["ops"][number]) =>
    t.mutation(api.expectations.propose, {
      api_token: apiToken,
      project: "Calls",
      summary: "Change the caller line",
      hold: true,
      ops: [op],
    });
  const edit = () =>
    propose({
      op: "edit",
      id: lineId,
      text: "Show the caller's full name.",
      citations: [citation],
    });
  const show = (id: string, version?: number) =>
    t.query(api.expectations.show, { api_token: apiToken, id, version });
  const read = () =>
    owner.query(api.expectations.forProject, { project_id: seed.project });
  const resolve = (proposal: string) =>
    owner.mutation(api.expectations.resolve, { proposal, action: "apply" });
  const proposalRow = (id: string) =>
    t.run(({ db }) =>
      db
        .query("expectation_proposals")
        .withIndex("by_short_id", (q) => q.eq("short_id", id))
        .unique(),
    );
  const linkCard = (id: string) =>
    t.run(async ({ db }) => {
      const conversation = await db.insert("conversations", {
        user_id: seed.user,
        session_id: "calls",
        agent_type: "claude_code",
        status: "active",
      });
      const card = await db.insert("session_decisions", {
        conversation_id: conversation,
        session_id: "calls",
        user_id: seed.user,
        question: "Apply this change?",
        options: [{ label: "Apply the change" }, { label: "Keep the line" }],
        blocking: true,
        status: "pending",
        silent: true,
        created_at: 1,
        updated_at: 1,
      });
      const proposal = await db
        .query("expectation_proposals")
        .withIndex("by_short_id", (q) => q.eq("short_id", id))
        .unique();
      await db.patch(proposal!._id, { decision_id: card });
      return card;
    });
  return {
    t,
    owner,
    writeVersion,
    propose,
    edit,
    show,
    read,
    resolve,
    proposalRow,
    linkCard,
  };
}

test("resolve leaves a stale proposal open and later reads give the refusal", async () => {
  const f = await fixture();
  await f.writeVersion(1);
  const { short_id: id } = await f.edit();
  await f.writeVersion(2);
  await expect(f.resolve(id)).rejects.toThrow("changed in version 2");
  expect(await f.proposalRow(id)).toMatchObject({ status: "open" });
  expect((await f.proposalRow(id))?.refused).toBeUndefined();

  const expected = {
    status: "open",
    refused: expect.stringContaining("changed in version 2"),
  };
  const historical = await f.show(id, 1);
  expect(historical).toMatchObject({
    doc: { version: 1 },
    current_version: 2,
    proposal: expected,
  });
  expect(historical.proposals).toEqual([expect.objectContaining(expected)]);
  expect((await f.read())?.proposals).toEqual([
    expect.objectContaining(expected),
  ]);
});

test("resolve also rolls back the linked card answer and reports the current refusal", async () => {
  const f = await fixture();
  await f.writeVersion(1);
  const { short_id: id } = await f.edit();
  const card = await f.linkCard(id);
  await f.writeVersion(2);
  await expect(f.resolve(id)).rejects.toThrow("changed in version 2");
  expect((await f.t.run(({ db }) => db.get(card)))?.status).toBe("pending");
  expect(await f.show(id)).toMatchObject({
    proposal: {
      status: "open",
      refused: expect.stringContaining("changed in version 2"),
    },
  });
});

test("a card answer leaves the same refusal visible and does not write it", async () => {
  const f = await fixture();
  await f.writeVersion(1);
  const { short_id: id } = await f.edit();
  const card = await f.linkCard(id);
  await f.writeVersion(2);
  await f.owner.mutation(api.sessionDecisions.resolve, {
    decision_id: card,
    status: "answered",
    answer_index: 0,
  });
  expect((await f.t.run(({ db }) => db.get(card)))?.status).toBe("answered");
  expect(await f.show(id)).toMatchObject({
    proposal: {
      status: "open",
      refused: expect.stringContaining("changed in version 2"),
    },
  });
  expect((await f.proposalRow(id))?.refused).toBeUndefined();
});

test("the current document replaces and clears a legacy refusal as the document changes", async () => {
  const f = await fixture();
  const { short_id: id } = await f.propose({
    op: "add",
    text,
    part: "Calls",
    citations: [citation],
  });
  const row = await f.proposalRow(id);
  await f.writeVersion(1);
  await f.t.run(({ db }) => db.patch(row!._id, { refused: "Old reason" }));
  const blocked = await f.show(id);
  await f.writeVersion(2, { status: "retired", added_in: 1 });
  const cleared = await f.show(id);
  expect(cleared).toMatchObject({ proposal: { status: "open" } });
  expect("proposal" in cleared && cleared.proposal).not.toHaveProperty(
    "refused",
  );
  expect(blocked).toMatchObject({
    proposal: { refused: expect.stringContaining("already expected as") },
  });
});

test("a list of stale proposals fits the read budget for one copy of the latest version", async () => {
  const count = 30;
  const f = await fixture(count + 7);
  await f.writeVersion(1);
  for (let i = 0; i < count; i++) await f.edit();
  await f.writeVersion(2);
  const read = await f.read();
  expect(read?.proposals).toHaveLength(count);
  for (const proposal of read!.proposals)
    expect(proposal).toMatchObject({
      status: "open",
      refused: expect.stringContaining("changed in version 2"),
    });
});
