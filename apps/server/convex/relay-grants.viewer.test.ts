import { afterEach, beforeEach, expect, jest, spyOn, test } from "bun:test";
import { asUser, serverTest } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import { api, internal } from "./_generated/api";

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
};

beforeEach(() => {
  process.env.RELAY_HMAC_KEY = key;
  process.env.RELAY_AUDIENCE = audience;
  delete process.env.RELAY_HMAC_PREVIOUS_KEY;
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

  await asUser(t, emailOnlyGuest).mutation(
    api.conversationSharing.redeemShareToken,
    {
      share_token: "identity-share-token",
    },
  );

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

    await asUser(t, guest).mutation(api.conversationSharing.redeemShareToken, {
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

test("pruneExpiredViewerGrants deletes expired rows in bounded pages and preserves active grants", async () => {
  const t = serverTest();
  const now = 1_800_000_000_000;
  jest.useFakeTimers();
  jest.setSystemTime(now);
  try {
    const { activeId } = await t.run(async ({ db }) => {
      const rows = fixtureRows(db, "viewer-prune-sweep");
      const user = await rows.user();
      const conv = await rows.conversation(user);
      for (let i = 0; i < 502; i++) {
        await db.insert("relay_viewer_grants", {
          conversation_id: conv,
          user_id: user,
          expires_at: now - i,
        });
      }
      const activeId = await db.insert("relay_viewer_grants", {
        conversation_id: conv,
        user_id: user,
        expires_at: now + 60_000,
      });
      return { activeId };
    });

    const firstPass = await t.mutation(
      internal.relayGrants.pruneExpiredViewerGrants,
      {},
    );
    expect(firstPass).toBe(500);
    expect(
      await t.run(({ db }) => db.query("relay_viewer_grants").collect()),
    ).toHaveLength(3);

    await t.finishAllScheduledFunctions(() => jest.runAllTimers());

    const remaining = await t.run(({ db }) =>
      db.query("relay_viewer_grants").collect(),
    );
    expect(remaining.map((row) => row._id)).toEqual([activeId]);
  } finally {
    jest.useRealTimers();
  }
});

test("mergeDuplicateUser deduplicates relay_viewer_grants by (conversation_id, user_id) keeping the later expires_at", async () => {
  const t = serverTest();
  const now = 1_800_000_000_000;
  const { fromUser, toUser, sourceNewerConv, destNewerConv, movedOnlyConv } =
    await t.run(async ({ db }) => {
      const rows = fixtureRows(db, "viewer-grant-user-merge");
      const fromUser = await rows.user({ email: "same-viewer@example.com" });
      const toUser = await rows.user({ email: "same-viewer@example.com" });
      const owner = await rows.user();
      const sourceNewerConv = await rows.conversation(owner);
      const destNewerConv = await rows.conversation(owner);
      const movedOnlyConv = await rows.conversation(owner);

      await db.insert("relay_viewer_grants", {
        conversation_id: sourceNewerConv,
        user_id: fromUser,
        expires_at: now + 50_000,
      });
      await db.insert("relay_viewer_grants", {
        conversation_id: sourceNewerConv,
        user_id: toUser,
        expires_at: now + 10_000,
      });

      await db.insert("relay_viewer_grants", {
        conversation_id: destNewerConv,
        user_id: fromUser,
        expires_at: now + 20_000,
      });
      await db.insert("relay_viewer_grants", {
        conversation_id: destNewerConv,
        user_id: toUser,
        expires_at: now + 40_000,
      });

      await db.insert("relay_viewer_grants", {
        conversation_id: movedOnlyConv,
        user_id: fromUser,
        expires_at: now + 30_000,
      });

      return {
        fromUser,
        toUser,
        sourceNewerConv,
        destNewerConv,
        movedOnlyConv,
      };
    });

  const merged = await t.mutation(internal.admin_mergeUser.mergeDuplicateUser, {
    from_user_id: fromUser,
    to_user_id: toUser,
    dry_run: false,
    delete_source: true,
  });
  expect(merged.source_deleted).toBe(true);

  const grants = await t.run(({ db }) =>
    db.query("relay_viewer_grants").collect(),
  );
  expect(grants).toHaveLength(3);
  const byConv = new Map(grants.map((grant) => [grant.conversation_id, grant]));
  expect(byConv.get(sourceNewerConv)).toMatchObject({
    user_id: toUser,
    expires_at: now + 50_000,
  });
  expect(byConv.get(destNewerConv)).toMatchObject({
    user_id: toUser,
    expires_at: now + 40_000,
  });
  expect(byConv.get(movedOnlyConv)).toMatchObject({
    user_id: toUser,
    expires_at: now + 30_000,
  });
});

test("viewer hub grants work without feature flags and block unauthorized callers", async () => {
  const t = serverTest();
  const { owner, teammate, outsider, conv } = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "viewer-hub-no-flags");
    const owner = await rows.user({ name: "Owner" });
    const teammate = await rows.user({ name: "Teammate" });
    const outsider = await rows.user({ name: "Outsider" });
    const team = await rows.team();
    await rows.membership(owner, team, { visibility: "full" });
    await rows.membership(teammate, team, { visibility: "full" });
    const conv = await rows.conversation(owner, {
      team_id: team,
      team_visibility: "full",
    });
    return { owner, teammate, outsider, conv };
  });

  expect(
    await asUser(t, teammate).query(api.relayGrants.viewerTarget, {
      conversation_id: conv,
    }),
  ).toEqual({
    viewer: teammate,
    hub: `viewer:${conv}`,
    tier: "member",
  });

  const granted = await asUser(t, teammate).mutation(mint, {
    hubs: [viewerSession(conv)],
  });
  expect(granted).toMatchObject({ status: "ok", omitted: [] });
  if (granted.status !== "ok") throw new Error("Expected ok");
  const payload = JSON.parse(
    Buffer.from(granted.token.split(".")[1], "base64url").toString("utf8"),
  );
  expect(payload.grants).toEqual([
    {
      kind: "session",
      id: `viewer:${conv}`,
      publish: ["presence", "draft_cursor", "reading_cursor"],
    },
  ]);

  expect(
    await asUser(t, outsider).mutation(mint, {
      hubs: [viewerSession(conv)],
    }),
  ).toEqual({
    status: "denied",
    omitted: [refused(`viewer:${conv}`)],
  });
});
