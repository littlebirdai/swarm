import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { asUser, serverTest } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import { api } from "./_generated/api";

const key = Buffer.alloc(32, 51).toString("base64url");
const audience = "cell-A";
const viewerSession = (id: string) => ({
  kind: "session" as const,
  id: `viewer:${id}`,
});
const refused = (id: string) => ({ id, reason: "inaccessible" });
const mint = api.relayGrants.mint;
const env = {
  RELAY_HMAC_KEY: process.env.RELAY_HMAC_KEY,
  RELAY_AUDIENCE: process.env.RELAY_AUDIENCE,
  RELAY_HMAC_PREVIOUS_KEY: process.env.RELAY_HMAC_PREVIOUS_KEY,
  CODECAST_RELAY_VIEWER_PRESENCE: process.env.CODECAST_RELAY_VIEWER_PRESENCE,
  CODECAST_RELAY_VIEWER_PRESENCE_SHARED:
    process.env.CODECAST_RELAY_VIEWER_PRESENCE_SHARED,
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

test("viewerIdentities masks email addresses, ignores non-present probes, and matches shared-tier rules", async () => {
  const t = serverTest();
  const {
    owner,
    presentTeammate,
    absentTeammate,
    emailOnlyGuest,
    stranger,
    full,
    privateShared,
  } = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "viewer-identity-privacy");
    const owner = await rows.user({ name: "Owner" });
    const presentTeammate = await rows.user({ name: "Present Member" });
    const absentTeammate = await rows.user({ name: "Absent Member" });
    const emailOnlyGuest = await db.insert("users", {
      email: "hidden.person@secret-domain.example",
    });
    const stranger = await rows.user({ name: "Stranger" });
    const team = await rows.team();
    await rows.membership(owner, team, { visibility: "full" });
    await rows.membership(presentTeammate, team, { visibility: "full" });
    await rows.membership(absentTeammate, team, { visibility: "full" });
    const full = await rows.conversation(owner, {
      team_id: team,
      team_visibility: "full",
    });
    const privateShared = await rows.conversation(owner, {
      team_id: team,
      team_visibility: "private",
      share_token: "identity-share-token",
    });
    return {
      owner,
      presentTeammate,
      absentTeammate,
      emailOnlyGuest,
      stranger,
      full,
      privateShared,
    };
  });

  process.env.CODECAST_RELAY_VIEWER_PRESENCE = "1";
  process.env.CODECAST_RELAY_VIEWER_PRESENCE_SHARED = "1";

  await asUser(t, emailOnlyGuest).mutation(api.conversations.redeemShareToken, {
    share_token: "identity-share-token",
  });

  expect(
    await asUser(t, owner).query(api.relayGrants.viewerIdentities, {
      conversation_id: full,
      user_ids: [absentTeammate, stranger],
    }),
  ).toEqual([]);

  expect(
    await asUser(t, presentTeammate).mutation(mint, {
      hubs: [viewerSession(full)],
    }),
  ).toMatchObject({ status: "ok", ttl_ms: 60_000 });
  expect(
    await asUser(t, emailOnlyGuest).mutation(mint, {
      hubs: [viewerSession(privateShared)],
    }),
  ).toMatchObject({ status: "ok", ttl_ms: 15_000 });
  expect(
    await asUser(t, owner).mutation(mint, {
      hubs: [viewerSession(privateShared)],
    }),
  ).toMatchObject({ status: "ok", ttl_ms: 60_000 });

  const fullResult = await asUser(t, owner).query(
    api.relayGrants.viewerIdentities,
    {
      conversation_id: full,
      user_ids: [presentTeammate, absentTeammate, emailOnlyGuest, stranger],
    },
  );
  expect(fullResult).toEqual([
    {
      user_id: presentTeammate,
      user_name: "Present Member",
      user_color: expect.any(String),
    },
  ]);

  const sharedForOwner = await asUser(t, owner).query(
    api.relayGrants.viewerIdentities,
    {
      conversation_id: privateShared,
      user_ids: [emailOnlyGuest, absentTeammate],
    },
  );
  expect(sharedForOwner).toEqual([
    {
      user_id: emailOnlyGuest,
      user_name: "hidden.person",
      user_color: expect.any(String),
    },
  ]);

  const sharedForGuest = await asUser(t, emailOnlyGuest).query(
    api.relayGrants.viewerIdentities,
    {
      conversation_id: privateShared,
      user_ids: [owner, absentTeammate],
    },
  );
  expect(sharedForGuest).toEqual([
    {
      user_id: owner,
      user_name: "Owner",
      user_color: expect.any(String),
    },
  ]);

  await t.run(async ({ db }) => {
    const row = await db
      .query("relay_viewer_grants")
      .withIndex("by_conversation_user", (q) =>
        q.eq("conversation_id", full).eq("user_id", presentTeammate),
      )
      .first();
    if (!row) throw new Error("Expected relay viewer grant row");
    await db.patch(row._id, { expires_at: Date.now() - 1 });
  });
  expect(
    await asUser(t, owner).query(api.relayGrants.viewerIdentities, {
      conversation_id: full,
      user_ids: [presentTeammate],
    }),
  ).toEqual([]);
});

test("viewer grants support mention grants, revoke on share rotation, and cap mixed-tier batches without charging refused mints", async () => {
  const t = serverTest();
  const now = 1_800_000_000_000;
  const clock = spyOn(Date, "now").mockReturnValue(now);
  try {
    const {
      owner,
      mentionMember,
      mentionMembership,
      guest,
      ownConv,
      summaryConv,
      sharedConv,
    } = await t.run(async ({ db }) => {
      const rows = fixtureRows(db, "viewer-mention-rotation-mixed");
      const owner = await rows.user({ name: "Owner" });
      const mentionMember = await rows.user({ name: "Mentioned Teammate" });
      const guest = await rows.user({ name: "Guest" });
      const team = await rows.team();
      await rows.membership(owner, team, { visibility: "full" });
      const mentionMembership = await rows.membership(mentionMember, team, {
        visibility: "summary",
      });
      const summaryConv = await rows.conversation(owner, {
        team_id: team,
        team_visibility: "summary",
      });
      const sharedConv = await rows.conversation(owner, {
        team_id: team,
        team_visibility: "private",
        share_token: "initial-share-token",
      });
      const ownConv = await rows.conversation(guest);
      await db.insert("conversation_read_grants", {
        conversation_id: summaryConv,
        user_id: mentionMember,
        granted_by: owner,
        source: "mention",
        created_at: now,
      });
      return {
        owner,
        mentionMember,
        mentionMembership,
        guest,
        ownConv,
        summaryConv,
        sharedConv,
      };
    });

    process.env.CODECAST_RELAY_VIEWER_PRESENCE = "1";
    process.env.CODECAST_RELAY_VIEWER_PRESENCE_SHARED = "1";

    expect(
      await asUser(t, mentionMember).query(api.relayGrants.viewerTarget, {
        conversation_id: summaryConv,
      }),
    ).toEqual({
      viewer: mentionMember,
      hub: `viewer:${summaryConv}`,
      tier: "shared",
    });
    const mentionGrant = await asUser(t, mentionMember).mutation(mint, {
      hubs: [viewerSession(summaryConv)],
    });
    expect(mentionGrant).toMatchObject({ status: "ok", ttl_ms: 15_000 });

    await t.run(({ db }) => db.delete(mentionMembership));
    expect(
      await asUser(t, mentionMember).query(api.relayGrants.viewerTarget, {
        conversation_id: summaryConv,
      }),
    ).toBeNull();
    expect(
      await asUser(t, mentionMember).mutation(mint, {
        hubs: [viewerSession(summaryConv)],
      }),
    ).toEqual({
      status: "denied",
      omitted: [refused(`viewer:${summaryConv}`)],
    });

    await asUser(t, guest).mutation(api.conversations.redeemShareToken, {
      share_token: "initial-share-token",
    });
    const mixed = await asUser(t, guest).mutation(mint, {
      hubs: [viewerSession(ownConv), viewerSession(sharedConv)],
    });
    expect(mixed).toMatchObject({ status: "ok", ttl_ms: 15_000 });

    const counterBeforeClockStep = await t.run(({ db }) =>
      db
        .query("rate_limits")
        .withIndex("by_user_endpoint", (q) =>
          q.eq("user_id", guest).eq("endpoint", "relayGrants.mint"),
        )
        .first(),
    );
    clock.mockReturnValue(now - 20_000);
    expect(
      await asUser(t, guest).mutation(mint, {
        hubs: [viewerSession(ownConv), viewerSession(sharedConv)],
      }),
    ).toEqual({ status: "unavailable" });
    expect(
      await t.run(({ db }) =>
        db
          .query("rate_limits")
          .withIndex("by_user_endpoint", (q) =>
            q.eq("user_id", guest).eq("endpoint", "relayGrants.mint"),
          )
          .first(),
      ),
    ).toEqual(counterBeforeClockStep);

    clock.mockReturnValue(now);
    await t.run(({ db }) =>
      db.patch(sharedConv, { share_token: "rotated-share-token" }),
    );
    expect(
      await asUser(t, guest).query(api.relayGrants.viewerTarget, {
        conversation_id: sharedConv,
      }),
    ).toBeNull();
    expect(
      await asUser(t, guest).mutation(mint, {
        hubs: [viewerSession(sharedConv)],
      }),
    ).toEqual({
      status: "denied",
      omitted: [refused(`viewer:${sharedConv}`)],
    });
    expect(
      await asUser(t, owner).query(api.relayGrants.viewerIdentities, {
        conversation_id: sharedConv,
        user_ids: [guest],
      }),
    ).toEqual([]);
  } finally {
    clock.mockRestore();
  }
});
