import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { parseRelayGrantClaims } from "@codecast/relay-contract";
import type { FunctionReturnType } from "convex/server";
import { asUser, serverTest } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import { api } from "./_generated/api";
import type { TableNames } from "./_generated/dataModel";
import schema from "./schema";

const key = Buffer.alloc(32, 51).toString("base64url");
const audience = "cell-A";
const session = (id: string) => ({ kind: "session" as const, id });
const refused = (id: string) => ({ id, reason: "inaccessible" });
const mint = api.relayGrants.mint;
const env = {
  RELAY_HMAC_KEY: process.env.RELAY_HMAC_KEY,
  RELAY_AUDIENCE: process.env.RELAY_AUDIENCE,
  RELAY_HMAC_PREVIOUS_KEY: process.env.RELAY_HMAC_PREVIOUS_KEY,
};

beforeEach(() => {
  process.env.RELAY_HMAC_KEY = key;
  process.env.RELAY_AUDIENCE = audience;
});

afterEach(() => {
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function claims(result: FunctionReturnType<typeof mint>) {
  if (result.status !== "ok") throw new Error(`Mint returned ${result.status}`);
  const payload = Buffer.from(result.token.split(".")[1], "base64url");
  const parsed = parseRelayGrantClaims(payload.toString());
  if (!parsed.ok) throw new Error("Invalid grant claims");
  return parsed.value;
}

test("session grants follow content visibility and the current presence writer", async () => {
  const t = serverTest();
  const {
    owner,
    teammate,
    outsider,
    full,
    summary,
    privateConversation,
    deleted,
    inherited,
    ownerMembership,
    teammateMembership,
  } = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "grant-access");
    const owner = await rows.user();
    const teammate = await rows.user();
    const outsider = await rows.user();
    const team = await rows.team();
    const ownerMembership = await rows.membership(owner, team, {
      visibility: "full",
    });
    const teammateMembership = await rows.membership(teammate, team, {
      visibility: "full",
    });
    const full = await rows.conversation(owner, {
      team_id: team,
      team_visibility: "full",
    });
    const summary = await rows.conversation(owner, {
      team_id: team,
      team_visibility: "summary",
    });
    const privateConversation = await rows.conversation(owner, {
      team_id: team,
      team_visibility: "private",
      share_token: "share-proof",
    });
    const deleted = await rows.conversation(owner, { team_id: team });
    await db.delete(deleted);
    const inherited = await rows.conversation(owner, {
      team_id: team,
      is_private: false,
    });
    return {
      owner,
      teammate,
      outsider,
      full,
      summary,
      privateConversation,
      deleted,
      inherited,
      ownerMembership,
      teammateMembership,
    };
  });

  const hubs = [full, summary, privateConversation, deleted].map(session);
  expect(await t.mutation(mint, { hubs })).toEqual({
    status: "unauthenticated",
  });

  const ownerGrant = await asUser(t, owner).mutation(mint, { hubs });
  expect(ownerGrant).toMatchObject({ omitted: [refused(deleted)] });
  expect(claims(ownerGrant).grants).toEqual(
    hubs.slice(0, 3).map((hub) => ({ ...hub, publish: ["presence"] })),
  );

  const teammateGrant = await asUser(t, teammate).mutation(mint, { hubs });
  expect(teammateGrant).toMatchObject({
    omitted: [summary, privateConversation, deleted].map(refused),
  });
  expect(claims(teammateGrant).grants).toEqual([
    { ...session(full), publish: ["presence"] },
  ]);
  const member = asUser(t, teammate);
  const inheritedArgs = { hubs: [session(inherited)] };
  expect(claims(await member.mutation(mint, inheritedArgs)).grants).toEqual([
    { ...session(inherited), publish: ["presence"] },
  ]);
  for (const visibility of ["summary", "activity", "hidden"] as const) {
    await t.run(({ db }) => db.patch(ownerMembership, { visibility }));
    expect(await member.mutation(mint, inheritedArgs)).toEqual({
      status: "denied",
      omitted: [refused(inherited)],
    });
  }
  await t.run(({ db }) => db.patch(ownerMembership, { visibility: "full" }));
  const stranger = asUser(t, outsider);
  expect(await stranger.mutation(mint, { hubs })).toEqual({
    status: "denied",
    omitted: [full, summary, privateConversation, deleted].map(refused),
  });
  const presented = await stranger.mutation(mint, {
    hubs: [
      session(privateConversation),
      {
        ...session(privateConversation),
        share_token: "share-proof",
      },
    ],
  });
  expect(presented).toMatchObject({ omitted: [] });
  expect(claims(presented).grants).toEqual([
    { ...session(privateConversation), publish: [] },
  ]);

  await stranger.mutation(api.conversations.redeemShareToken, {
    share_token: "share-proof",
  });
  const redeemed = await stranger.mutation(mint, {
    hubs: [session(privateConversation)],
  });
  expect(claims(redeemed).grants).toEqual([
    { ...session(privateConversation), publish: ["presence"] },
  ]);
  await t.run(async ({ db }) => {
    await db.delete(teammateMembership);
    await db.patch(privateConversation, { share_token: undefined });
  });
  expect(
    await asUser(t, teammate).mutation(mint, { hubs: [session(full)] }),
  ).toEqual({
    status: "denied",
    omitted: [refused(full)],
  });
  expect(
    await stranger.mutation(mint, {
      hubs: [{ ...session(privateConversation), share_token: "share-proof" }],
    }),
  ).toEqual({ status: "denied", omitted: [refused(privateConversation)] });
});

test("bounds batches and leaves only the caller's limiter row when enabled", async () => {
  const t = serverTest();
  const { owner, hubs } = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "grant-write-budget");
    const owner = await rows.user();
    const hubs = await Promise.all(
      Array.from({ length: 17 }, () => rows.conversation(owner)),
    );
    return { owner, hubs: hubs.map(session) };
  });
  const caller = asUser(t, owner);
  const snapshot = () =>
    t.run(async ({ db }) =>
      Object.fromEntries(
        await Promise.all(
          (Object.keys(schema.tables) as TableNames[]).map(async (table) => [
            table,
            await db.query(table).collect(),
          ]),
        ),
      ),
    );
  const before = await snapshot();
  delete process.env.RELAY_HMAC_KEY;
  process.env.RELAY_HMAC_PREVIOUS_KEY = key;
  try {
    expect(await caller.mutation(mint, { hubs: hubs.slice(0, 16) })).toEqual({
      status: "unavailable",
    });
  } finally {
    delete process.env.RELAY_HMAC_PREVIOUS_KEY;
  }
  process.env.RELAY_HMAC_KEY = key;
  for (const invalid of [[], hubs]) {
    expect(await caller.mutation(mint, { hubs: invalid })).toEqual({
      status: "invalid_hub_count",
    });
  }
  expect(await snapshot()).toEqual(before);

  const result = await caller.mutation(mint, { hubs: hubs.slice(0, 16) });
  expect(claims(result).grants).toHaveLength(16);
  const { rate_limits, ...others } = await snapshot();
  expect({ ...others, rate_limits: [] }).toEqual(before);
  expect(rate_limits).toEqual([
    {
      _id: expect.any(String),
      _creationTime: expect.any(Number),
      user_id: owner,
      endpoint: "relayGrants.mint",
      window_start: expect.any(Number),
      request_count: 1,
      last_request_at: expect.any(Number),
      sequence: expect.any(Number),
    },
  ]);
  const counter = await t.run(({ db }) => db.query("rate_limits").unique());
  if (!counter) throw new Error("Missing limiter row");
  await t.run(({ db }) => db.patch(counter._id, { request_count: 120 }));
  expect(await caller.mutation(mint, { hubs: hubs.slice(0, 1) })).toEqual({
    status: "rate_limited",
  });
  expect(await t.run(({ db }) => db.query("rate_limits").collect())).toEqual([
    { ...counter, request_count: 120 },
  ]);
});

test("same-millisecond mints are ordered and expiry respects both auth deadlines", async () => {
  const t = serverTest();
  const now = 1_800_000_000_000;
  const clock = spyOn(Date, "now").mockReturnValue(now);
  try {
    const { owner, auth, hubs } = await t.run(async ({ db }) => {
      const rows = fixtureRows(db, "grant-expiry");
      const owner = await rows.user();
      const auth = await db.insert("authSessions", {
        userId: owner,
        expirationTime: now + 5000,
      });
      return { owner, auth, hubs: [session(await rows.conversation(owner))] };
    });
    const caller = t.withIdentity({ subject: `${owner}|${auth}` });
    const [first, second] = (
      await Promise.all([
        caller.mutation(mint, { hubs }),
        caller.mutation(mint, { hubs }),
      ])
    )
      .map(claims)
      .sort((a, b) => a.grant_seq - b.grant_seq);
    expect(first.issued_at_ms).toBe(now);
    expect(second.issued_at_ms).toBe(now);
    expect(second.grant_seq).toBeGreaterThan(first.grant_seq);
    expect(second.expires_at_ms).toBe(now + 5000);
    clock.mockReturnValue(now - 1);
    const afterClockStep = claims(await caller.mutation(mint, { hubs }));
    expect(afterClockStep.issued_at_ms).toBe(now);
    expect(afterClockStep.grant_seq).toBeGreaterThan(second.grant_seq);
    clock.mockReturnValue(now);
    const jwtCaller = t.withIdentity({
      subject: `${owner}|${auth}`,
      exp: now / 1000 + 2,
    });
    const jwtBound = await jwtCaller.mutation(mint, { hubs });
    expect(jwtBound).toMatchObject({ ttl_ms: 2000 });
    expect(claims(jwtBound).expires_at_ms).toBe(now + 2000);
    clock.mockReturnValue(now + 5000);
    expect(await caller.mutation(mint, { hubs })).toEqual({
      status: "unauthenticated",
    });
  } finally {
    clock.mockRestore();
  }
});
