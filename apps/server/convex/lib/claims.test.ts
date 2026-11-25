import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { serverTest } from "../../test-helpers/database.testkit";
import { fixtureRows } from "../../test-helpers/rows.testkit";
import {
  checkClaim,
  claim,
  readClaimToken,
  release,
  renew,
  revoke,
  type CallerAuthorizedClaimUse,
} from "./claims";

const start = 1_800_000_000_000;

function advance(ms: number) {
  setSystemTime(new Date(start + ms));
}

beforeEach(() => advance(0));
afterEach(() => setSystemTime());

async function setup() {
  const t = serverTest();
  const { ana, ben, conversation } = await t.run(async ({ db }) => {
    const fixtures = fixtureRows(db, "claims");
    const ana = await fixtures.user();
    const ben = await fixtures.user();
    const conversation = await fixtures.conversation(ana);
    return { ana, ben, conversation };
  });
  const baton = { kind: "steer", id: conversation } as const;
  const pane = { kind: "terminal", id: conversation } as const;

  return {
    t,
    ana,
    ben,
    baton,
    pane,
    claimPane: (holder = ana, requestId = "first", expectedToken = 0) =>
      t.run((ctx) => claim(ctx, { ...pane, holder, requestId, expectedToken })),
    rows: () => t.run(({ db }) => db.query("claims").collect()),
    guardedWrite: (input: CallerAuthorizedClaimUse) =>
      t.run(async (ctx) => {
        const result = await checkClaim(ctx, input);
        if (result.status === "held") {
          const row = await ctx.db.get("conversations", conversation);
          if (!row) throw new Error("Missing test conversation");
          await ctx.db.patch("conversations", conversation, {
            message_count: row.message_count + 1,
          });
        }
        return result;
      }),
    writes: async () =>
      (await t.run(({ db }) => db.get("conversations", conversation)))
        ?.message_count,
  };
}

test("only a second sender materializes the lone turn starter's baton", async () => {
  const f = await setup();
  const starter = {
    ...f.baton,
    holder: f.ana,
    expectedToken: 0,
    requestId: "first-contest",
  };
  expect(
    await f.t.run((ctx) =>
      claim(ctx, { ...starter, steering: { mode: "lone" } }),
    ),
  ).toEqual({ status: "lone" });
  expect(
    await f.t.run((ctx) =>
      claim(ctx, {
        ...starter,
        steering: { mode: "second_request", requester: f.ana },
      }),
    ),
  ).toEqual({ status: "lone" });
  expect(await f.rows()).toEqual([]);

  expect(
    await f.t.run((ctx) =>
      claim(ctx, {
        ...starter,
        steering: { mode: "second_request", requester: f.ben },
      }),
    ),
  ).toEqual({ status: "held", token: 1, remainingMs: 30_000 });
  expect(await f.rows()).toEqual([
    expect.objectContaining({
      kind: "steer",
      purpose: "turn_baton",
      holder: f.ana,
      lease_until: start + 30_000,
    }),
  ]);

  const ben = {
    ...starter,
    holder: f.ben,
    requestId: "steer-now",
    expectedToken: 1,
    steering: { mode: "contested" },
  } as const;
  expect(await f.t.run((ctx) => claim(ctx, ben))).toEqual({
    status: "busy",
    remainingMs: 30_000,
  });
  advance(30_000);
  expect(
    await f.t.run((ctx) => claim(ctx, { ...ben, requestId: "steer-again" })),
  ).toEqual({
    status: "held",
    token: 2,
    remainingMs: 30_000,
  });
});

test("the baton and each pane instance have independent claims", async () => {
  const f = await setup();
  await f.t.run((ctx) =>
    claim(ctx, {
      ...f.baton,
      steering: { mode: "contested" },
      holder: f.ben,
      requestId: "baton",
      expectedToken: 0,
    }),
  );
  expect(await f.claimPane()).toEqual({
    status: "held",
    token: 1,
    remainingMs: 20_000,
  });
  const replacement = { kind: "terminal", id: "replacement-instance" } as const;
  expect(
    await f.guardedWrite({ resource: replacement, holder: f.ana, token: 1 }),
  ).toEqual({ status: "free" });
  expect(await f.writes()).toBe(0);
  expect(
    await f.t.run((ctx) =>
      claim(ctx, {
        ...replacement,
        holder: f.ben,
        requestId: "replacement",
        expectedToken: 0,
      }),
    ),
  ).toEqual({ status: "held", token: 1, remainingMs: 20_000 });
  expect(await f.rows()).toHaveLength(3);
  expect(await f.rows()).toContainEqual(
    expect.objectContaining({
      kind: "terminal",
      resource_id: f.pane.id,
      purpose: "typing_lease",
      holder: f.ana,
    }),
  );
});

test("concurrent claims grant one holder and create one row", async () => {
  const f = await setup();
  const attempts = await Promise.all([
    f.claimPane(f.ana, "ana"),
    f.claimPane(f.ben, "ben"),
  ]);
  expect(attempts).toContainEqual({
    status: "held",
    token: 1,
    remainingMs: 20_000,
  });
  expect(attempts).toContainEqual({ status: "stale_request", currentToken: 1 });
  expect(await f.rows()).toHaveLength(1);
  expect(await f.claimPane(f.ben, "another", 1)).toEqual({
    status: "busy",
    remainingMs: 20_000,
  });
});

test("a lost reply returns the same token and current remaining time", async () => {
  const f = await setup();
  const first = await f.claimPane();
  expect(first).toEqual({ status: "held", token: 1, remainingMs: 20_000 });
  advance(4_000);
  expect(await f.claimPane()).toEqual({
    status: "held",
    token: 1,
    remainingMs: 16_000,
  });
  expect(await f.claimPane(f.ana, "different-request")).toEqual({
    status: "stale_request",
    currentToken: 1,
  });
  expect(await f.claimPane(f.ana, "first", 1)).toEqual({
    status: "busy",
    remainingMs: 16_000,
  });
  expect(await f.claimPane(f.ben)).toEqual({
    status: "stale_request",
    currentToken: 1,
  });
  expect(await f.rows()).toEqual([
    expect.objectContaining({ token: 1, lease_until: start + 20_000 }),
  ]);
  advance(20_000);
  expect(await f.claimPane()).toEqual({ status: "inactive_request" });
});

test("renewal extends only the current holder's live lease", async () => {
  const f = await setup();
  await f.claimPane();
  const use = { resource: f.pane, holder: f.ana, token: 1 };
  advance(10_000);
  expect(await f.t.run((ctx) => renew(ctx, { ...use, holder: f.ben }))).toEqual(
    {
      status: "wrong_holder",
    },
  );
  expect(await f.t.run((ctx) => renew(ctx, use))).toEqual({
    status: "held",
    token: 1,
    remainingMs: 20_000,
  });
  advance(9_000);
  expect(await f.t.run((ctx) => renew(ctx, use))).toEqual({
    status: "held",
    token: 1,
    remainingMs: 21_000,
  });
  advance(20_000);
  expect(await f.guardedWrite(use)).toEqual({
    status: "held",
    token: 1,
    remainingMs: 10_000,
  });
  expect(await f.writes()).toBe(1);
  advance(30_000);
  expect(await f.t.run((ctx) => renew(ctx, use))).toEqual({
    status: "expired",
  });
});

test("expiry denies writes at the exact boundary and takeover fences the old token", async () => {
  const f = await setup();
  await f.claimPane();
  const old = { resource: f.pane, holder: f.ana, token: 1 };
  advance(19_999);
  expect(await f.guardedWrite(old)).toEqual({
    status: "held",
    token: 1,
    remainingMs: 1,
  });
  advance(20_000);
  expect(await f.guardedWrite(old)).toEqual({ status: "expired" });
  expect(await f.claimPane(f.ana, "takeover", 1)).toEqual({
    status: "held",
    token: 2,
    remainingMs: 20_000,
  });
  expect(await f.guardedWrite(old)).toEqual({ status: "stale_token" });
  expect(await f.t.run((ctx) => renew(ctx, old))).toEqual({
    status: "stale_token",
  });
  expect(await f.t.run((ctx) => release(ctx, old))).toEqual({
    status: "stale_token",
  });
  expect(await f.claimPane()).toEqual({
    status: "stale_request",
    currentToken: 2,
  });
  expect(await f.writes()).toBe(1);
});

test("only the holder can write or release, and release retains the token", async () => {
  const f = await setup();
  await f.claimPane();
  const use = { resource: f.pane, holder: f.ana, token: 1 };
  const other = { ...use, holder: f.ben };
  expect(await f.guardedWrite(other)).toEqual({ status: "wrong_holder" });
  expect(await f.writes()).toBe(0);
  expect(await f.t.run((ctx) => release(ctx, other))).toEqual({
    status: "wrong_holder",
  });
  expect(await f.t.run((ctx) => release(ctx, use))).toEqual({
    status: "cleared",
    token: 1,
  });
  expect(await f.t.run((ctx) => readClaimToken(ctx, f.pane))).toBe(1);
  expect(await f.guardedWrite(use)).toEqual({ status: "free" });
  expect(await f.claimPane()).toEqual({ status: "inactive_request" });
  expect(await f.claimPane(f.ben, "next", 1)).toEqual({
    status: "held",
    token: 2,
    remainingMs: 20_000,
  });
});

test("revocation stops writes in its transaction and a delayed revoke leaves the successor", async () => {
  const f = await setup();
  await f.claimPane();
  const use = { resource: f.pane, holder: f.ana, token: 1 };
  const stop = { resource: f.pane, targetHolder: f.ana, token: 1 };
  expect((await f.guardedWrite(use)).status).toBe("held");
  await f.t.run(async (ctx) => {
    expect(await revoke(ctx, stop)).toEqual({ status: "cleared", token: 1 });
    expect(await checkClaim(ctx, use)).toEqual({ status: "free" });
  });
  expect(await f.guardedWrite(use)).toEqual({ status: "free" });
  expect(await f.writes()).toBe(1);
  expect(await f.claimPane(f.ben, "after-revoke", 1)).toEqual({
    status: "held",
    token: 2,
    remainingMs: 20_000,
  });
  expect(await f.t.run((ctx) => revoke(ctx, stop))).toEqual({
    status: "stale_token",
  });
  expect(
    await f.guardedWrite({ resource: f.pane, holder: f.ben, token: 2 }),
  ).toEqual({ status: "held", token: 2, remainingMs: 20_000 });
});

test("the final safe token cannot roll over", async () => {
  const f = await setup();
  await f.t.run(({ db }) =>
    db.insert("claims", {
      kind: "terminal",
      resource_id: f.pane.id,
      purpose: "typing_lease",
      token: Number.MAX_SAFE_INTEGER,
      lease_until: 0,
      request_id: "last",
    }),
  );
  expect(await f.claimPane(f.ana, "overflow", Number.MAX_SAFE_INTEGER)).toEqual(
    {
      status: "token_exhausted",
    },
  );
  expect(await f.t.run((ctx) => readClaimToken(ctx, f.pane))).toBe(
    Number.MAX_SAFE_INTEGER,
  );
});
