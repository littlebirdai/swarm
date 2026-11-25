import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { asUser, serverTest } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import { api, internal } from "./_generated/api";
import { claim } from "./lib/claims";
import { DELETION_PASS_BUDGET } from "./regulatedDeletion";

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test("ordinary session deletion purges both claims", async () => {
  const t = serverTest();
  const { owner, conversation } = await t.run(async (ctx) => {
    const fixtures = fixtureRows(ctx.db, "ordinary-claim-deletion");
    const owner = await fixtures.user();
    const conversation = await fixtures.conversation(owner, {
      status: "completed",
    });
    await claim(ctx, {
      kind: "steer",
      id: conversation,
      holder: owner,
      steering: { mode: "contested" },
      requestId: "steer",
      expectedToken: 0,
    });
    await claim(ctx, {
      kind: "terminal",
      id: conversation,
      paneInstance: 1,
      holder: owner,
      requestId: "terminal",
      expectedToken: 0,
    });
    return { owner, conversation };
  });
  expect(await t.run(({ db }) => db.query("claims").collect())).toHaveLength(2);
  expect(
    await asUser(t, owner).mutation(api.sessionDelete.deleteSession, {
      conversation_id: conversation,
    }),
  ).toEqual({ deleted: 1 });
  expect(await t.run(({ db }) => db.get(conversation))).toBeNull();
  await t.finishAllScheduledFunctions(() => jest.runAllTimers());
  expect(await t.run(({ db }) => db.query("claims").collect())).toEqual([]);
});

test("regulated team deletion retains claims between passes until the conversation is gone", async () => {
  const t = serverTest();
  const { owner, team, conversation } = await t.run(async ({ db }) => {
    const fixtures = fixtureRows(db, "team-claim-deletion");
    const owner = await fixtures.user();
    const team = await fixtures.team({
      name: "Regulated team",
      policy: { regulated_data: true },
    });
    await fixtures.membership(owner, team, { role: "admin" });
    const conversation = await fixtures.conversation(owner, {
      team_id: team,
      status: "completed",
    });
    await db.insert("claims", {
      conversation_id: conversation,
      kind: "steer",
      token: 3,
      lease_until: 0,
    });
    await db.insert("claims", {
      conversation_id: conversation,
      kind: "terminal",
      pane_instance: 8,
      holder: owner,
      token: 7,
      lease_until: Date.now() + 20_000,
    });
    for (let i = 0; i < DELETION_PASS_BUDGET / 10 + 1; i++) {
      await db.insert("tree_snapshots", {
        conversation_id: conversation,
        sha: `commit-${i}`,
        tree_sha: "tree",
        base_sha: "base",
        depth: 0,
        changed_paths: [],
        changed_count: 0,
        dirty: false,
        checkout_key: "repo",
        source: "turn",
        taken_at: i,
      });
    }
    return { owner, team, conversation };
  });
  const claims = await t.run(({ db }) => db.query("claims").collect());
  const { deletion_id } = await asUser(t, owner).mutation(
    api.regulatedDeletion.destroyTeam,
    {
      team_id: team,
      confirm_name: "Regulated team",
    },
  );
  expect(
    await t.mutation(internal.regulatedDeletion.runDeletion, {
      deletion_id,
      gen: 0,
    }),
  ).toEqual({ done: false });
  expect(await t.run(({ db }) => db.get(conversation))).not.toBeNull();
  expect(await t.run(({ db }) => db.query("claims").collect())).toEqual(claims);
  expect(
    await t.run(async ({ db }) => {
      const deletion = await db.get(deletion_id);
      return deletion?.counts.tree_snapshots;
    }),
  ).toBeGreaterThan(0);

  await t.finishAllScheduledFunctions(() => jest.runAllTimers());
  expect(await t.run(({ db }) => db.get(conversation))).toBeNull();
  expect(await t.run(({ db }) => db.query("claims").collect())).toEqual([]);
  expect(await t.run(({ db }) => db.get(deletion_id))).toMatchObject({
    status: "done",
    counts: { claims: 2 },
  });
});

test("account deletion clears claim identities and preserves the token and pane", async () => {
  const t = serverTest();
  const { deleted, owner, conversation, activeClaim, lastRequest } =
    await t.run(async ({ db }) => {
      const fixtures = fixtureRows(db, "account-claim-deletion");
      const deleted = await fixtures.user();
      const owner = await fixtures.user();
      const conversation = await fixtures.conversation(owner);
      const activeClaim = await db.insert("claims", {
        conversation_id: conversation,
        kind: "terminal",
        pane_instance: 6,
        holder: deleted,
        token: 4,
        lease_until: Date.now() + 20_000,
        request_id: "live",
        request_holder: deleted,
      });
      const lastRequest = await db.insert("claims", {
        conversation_id: conversation,
        kind: "steer",
        token: 9,
        lease_until: 0,
        request_id: "released",
        request_holder: deleted,
      });
      return { deleted, owner, conversation, activeClaim, lastRequest };
    });

  await t.mutation(internal.accountDelete.purgeAccount, { user_id: deleted });
  expect(await t.run(({ db }) => db.get(deleted))).toBeNull();
  expect(await t.run(({ db }) => db.get(conversation))).not.toBeNull();
  const terminal = await t.run(({ db }) => db.get(activeClaim));
  const steer = await t.run(({ db }) => db.get(lastRequest));
  expect(terminal).toMatchObject({
    token: 4,
    pane_instance: 6,
    lease_until: 0,
  });
  expect(steer).toMatchObject({ token: 9, lease_until: 0 });
  for (const row of [terminal, steer]) {
    expect(row).not.toHaveProperty("holder");
    expect(row).not.toHaveProperty("request_id");
    expect(row).not.toHaveProperty("request_holder");
  }

  const next = {
    kind: "terminal",
    id: conversation,
    holder: owner,
    requestId: "next",
    expectedToken: 4,
  } as const;
  expect(
    await t.run((ctx) => claim(ctx, { ...next, paneInstance: 5 })),
  ).toEqual({
    status: "wrong_pane",
  });
  expect(
    await t.run((ctx) => claim(ctx, { ...next, paneInstance: 6 })),
  ).toMatchObject({
    status: "held",
    token: 5,
  });
});
