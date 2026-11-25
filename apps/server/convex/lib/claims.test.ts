import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { serverTest } from "../../test-helpers/database.testkit";
import { fixtureRows } from "../../test-helpers/rows.testkit";
import {
  claim,
  readClaimToken,
  release,
  renew,
  revoke,
  withHeldClaim,
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
  const pane = {
    kind: "terminal",
    id: conversation,
    paneInstance: 1,
  } as const;

  return {
    t,
    ana,
    ben,
    baton,
    pane,
    claimPane: (
      holder = ana,
      requestId = "first",
      expectedToken = 0,
      paneInstance = pane.paneInstance,
    ) =>
      t.run((ctx) =>
        claim(ctx, { ...pane, holder, requestId, expectedToken, paneInstance }),
      ),
    rows: () => t.run(({ db }) => db.query("claims").collect()),
    guardedWrite: (input: CallerAuthorizedClaimUse) =>
      t.run((ctx) =>
        withHeldClaim(ctx, input, async ({ db }) => {
          const row = await db.get("conversations", conversation);
          if (!row) throw new Error("Missing test conversation");
          await db.patch("conversations", conversation, {
            message_count: row.message_count + 1,
          });
          return row.message_count + 1;
        }),
      ),
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
      claim(ctx, { ...f.baton, holder: f.ana, steering: { mode: "lone" } }),
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

test("pane changes keep one terminal row and fence the replaced pane", async () => {
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
  const replacement = { ...f.pane, paneInstance: 2 };
  const newPaneRequest = {
    ...replacement,
    holder: f.ana,
    requestId: "pane-changed",
    expectedToken: 1,
  };
  const old = { resource: f.pane, holder: f.ana, token: 1 };
  const newPaneUse = { ...old, resource: replacement };
  expect(await f.guardedWrite(newPaneUse)).toEqual({ status: "wrong_pane" });
  expect(await f.writes()).toBe(0);
  expect(
    await f.t.run((ctx) => claim(ctx, { ...newPaneRequest, expectedToken: 0 })),
  ).toEqual({ status: "stale_request", currentToken: 1 });
  expect(
    await f.t.run((ctx) =>
      claim(ctx, { ...newPaneRequest, requestId: "first" }),
    ),
  ).toEqual({ status: "inactive_request" });
  expect(await f.t.run((ctx) => claim(ctx, newPaneRequest))).toEqual({
    status: "pane_changed",
    currentToken: 1,
  });
  expect(await f.t.run((ctx) => claim(ctx, newPaneRequest))).toEqual({
    status: "inactive_request",
  });
  expect(await f.t.query(({ db }) => readClaimToken(db, replacement))).toBe(1);
  expect(await f.guardedWrite(old)).toEqual({ status: "wrong_pane" });
  expect(await f.guardedWrite(newPaneUse)).toEqual({ status: "free" });
  expect(await f.t.run((ctx) => renew(ctx, old))).toEqual({
    status: "wrong_pane",
  });
  expect(await f.t.run((ctx) => release(ctx, old))).toEqual({
    status: "wrong_pane",
  });
  expect(
    await f.t.run((ctx) =>
      revoke(ctx, { resource: f.pane, targetHolder: f.ana, token: 1 }),
    ),
  ).toEqual({ status: "wrong_pane" });
  expect(
    await f.t.run((ctx) =>
      claim(ctx, { ...newPaneRequest, requestId: "new-lease" }),
    ),
  ).toEqual({ status: "held", token: 2, remainingMs: 20_000 });
  expect(await f.guardedWrite(newPaneUse)).toEqual({ status: "stale_token" });
  expect(await f.writes()).toBe(0);
  expect(await f.rows()).toEqual([
    expect.objectContaining({
      kind: "steer",
      resource_id: f.baton.id,
      holder: f.ben,
      token: 1,
    }),
    expect.objectContaining({
      kind: "terminal",
      resource_id: f.pane.id,
      pane_instance: 2,
      holder: f.ana,
      token: 2,
    }),
  ]);
});

test("a delayed pane 1 claim leaves the newly switched pane 2 unchanged", async () => {
  const f = await setup();
  await f.claimPane();
  const delayed = () => f.claimPane(f.ana, "delayed-pane-1", 1);
  expect(await f.claimPane(f.ben, "switch-pane-2", 1, 2)).toEqual({
    status: "pane_changed",
    currentToken: 1,
  });
  const rows = await f.rows();
  const result = await delayed();
  expect(await f.rows()).toEqual(rows);
  expect(result).toEqual({ status: "wrong_pane" });
});

test("a stale pane 1 claim preserves the live holder on pane 2", async () => {
  const f = await setup();
  await f.claimPane();
  await f.claimPane(f.ben, "switch-pane-2", 1, 2);
  expect(await f.claimPane(f.ben, "claim-pane-2", 1, 2)).toEqual({
    status: "held",
    token: 2,
    remainingMs: 20_000,
  });
  const rows = await f.rows();
  const result = await f.claimPane(f.ana, "stale-pane-1", 2);
  expect(await f.rows()).toEqual(rows);
  expect(result).toEqual({ status: "wrong_pane" });
});

test("a retry of the pane 2 request leaves pane 3 unchanged", async () => {
  const f = await setup();
  await f.claimPane();
  const switchToSecond = () => f.claimPane(f.ben, "switch-pane-2", 1, 2);
  expect(await switchToSecond()).toEqual({
    status: "pane_changed",
    currentToken: 1,
  });
  expect(await f.claimPane(f.ana, "switch-pane-3", 1, 3)).toEqual({
    status: "pane_changed",
    currentToken: 1,
  });
  const rows = await f.rows();
  const result = await switchToSecond();
  expect(await f.rows()).toEqual(rows);
  expect(result).toEqual({ status: "wrong_pane" });
});

test("claims refuse empty request IDs and non-positive or unsafe pane instances", async () => {
  const f = await setup();
  expect(await f.claimPane(f.ana, "")).toEqual({ status: "invalid_request" });
  for (const paneInstance of [
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    expect(await f.claimPane(f.ana, "invalid-pane", 0, paneInstance)).toEqual({
      status: "invalid_pane",
    });
    expect(
      await f.guardedWrite({
        resource: { ...f.pane, paneInstance },
        holder: f.ana,
        token: 1,
      }),
    ).toEqual({ status: "wrong_pane" });
  }
  expect(await f.rows()).toEqual([]);
  expect(
    await f.claimPane(f.ana, "largest-pane", 0, Number.MAX_SAFE_INTEGER),
  ).toEqual({
    status: "held",
    token: 1,
    remainingMs: 20_000,
  });
});

test("lone and self requests respect live batons and a second sender reuses a released row", async () => {
  const f = await setup();
  const lone = {
    ...f.baton,
    holder: f.ana,
    steering: { mode: "lone" },
  } as const;
  const second = {
    ...f.baton,
    holder: f.ana,
    steering: { mode: "second_request", requester: f.ben },
    requestId: "first-turn",
    expectedToken: 0,
  } as const;
  expect(await f.t.run((ctx) => claim(ctx, second))).toEqual({
    status: "held",
    token: 1,
    remainingMs: 30_000,
  });
  const granted = await f.rows();
  advance(1_000);
  for (const [holder, result] of [
    [f.ana, { status: "held", token: 1, remainingMs: 29_000 }],
    [f.ben, { status: "busy", remainingMs: 29_000 }],
  ] as const) {
    expect(await f.t.run((ctx) => claim(ctx, { ...lone, holder }))).toEqual(
      result,
    );
    expect(
      await f.t.run((ctx) =>
        claim(ctx, {
          ...second,
          holder,
          requestId: "self",
          steering: { mode: "second_request", requester: holder },
        }),
      ),
    ).toEqual(result);
  }
  expect(await f.rows()).toEqual(granted);
  await f.t.run((ctx) =>
    release(ctx, { resource: f.baton, holder: f.ana, token: 1 }),
  );
  const released = await f.rows();
  expect(await f.t.run((ctx) => claim(ctx, lone))).toEqual({ status: "lone" });
  expect(await f.rows()).toEqual(released);
  expect(
    await f.t.run((ctx) =>
      claim(ctx, { ...second, requestId: "second-turn", expectedToken: 1 }),
    ),
  ).toEqual({
    status: "held",
    token: 2,
    remainingMs: 30_000,
  });
  expect(await f.rows()).toEqual([
    expect.objectContaining({ _id: released[0]?._id, token: 2 }),
  ]);
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
    status: "held",
    token: 1,
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
  expect(await f.claimPane(f.ana, "first", 1)).toEqual({
    status: "inactive_request",
  });
  expect(await f.claimPane(f.ben, "first", 1)).toEqual({
    status: "stale_request",
    currentToken: 1,
  });
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
    value: 1,
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
    value: 1,
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
  expect(await f.t.query(({ db }) => readClaimToken(db, f.pane))).toBe(1);
  expect(await f.guardedWrite(use)).toEqual({ status: "free" });
  expect(await f.claimPane(f.ana, "first", 1)).toEqual({
    status: "inactive_request",
  });
  expect(await f.claimPane(f.ben, "first", 1)).toEqual({
    status: "stale_request",
    currentToken: 1,
  });
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
    expect(await revoke(ctx, { ...stop, targetHolder: f.ben })).toEqual({
      status: "wrong_holder",
    });
    expect(await revoke(ctx, stop)).toEqual({ status: "cleared", token: 1 });
    expect(
      await withHeldClaim(ctx, use, () => {
        throw new Error("revoked callback ran");
      }),
    ).toEqual({ status: "free" });
  });
  expect(await f.guardedWrite(use)).toEqual({ status: "free" });
  expect(await f.writes()).toBe(1);
  expect(await f.claimPane(f.ana, "first", 1)).toEqual({
    status: "inactive_request",
  });
  expect(await f.claimPane(f.ben, "first", 1)).toEqual({
    status: "stale_request",
    currentToken: 1,
  });
  expect(await f.claimPane(f.ben, "after-revoke", 1)).toEqual({
    status: "held",
    token: 2,
    remainingMs: 20_000,
  });
  expect(await f.claimPane()).toEqual({
    status: "stale_request",
    currentToken: 2,
  });
  expect(await f.t.run((ctx) => revoke(ctx, stop))).toEqual({
    status: "stale_token",
  });
  const successor = { resource: f.pane, holder: f.ben, token: 2 };
  expect(await f.guardedWrite(successor)).toEqual({
    status: "held",
    token: 2,
    remainingMs: 20_000,
    value: 2,
  });
  await f.t.run((ctx) => release(ctx, successor));
  expect(await f.claimPane()).toEqual({
    status: "stale_request",
    currentToken: 2,
  });
});

test("the final safe token cannot roll over", async () => {
  const f = await setup();
  await f.t.run(({ db }) =>
    db.insert("claims", {
      kind: "terminal",
      resource_id: f.pane.id,
      pane_instance: f.pane.paneInstance,
      purpose: "typing_lease",
      token: Number.MAX_SAFE_INTEGER,
      lease_until: 0,
      request_id: "last",
      request_holder: f.ana,
    }),
  );
  expect(await f.claimPane(f.ana, "overflow", Number.MAX_SAFE_INTEGER)).toEqual(
    {
      status: "token_exhausted",
    },
  );
  expect(await f.t.query(({ db }) => readClaimToken(db, f.pane))).toBe(
    Number.MAX_SAFE_INTEGER,
  );
});
