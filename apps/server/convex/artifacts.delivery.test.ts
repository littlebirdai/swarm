import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import schema from "./schema";
import { allModules } from "./testModules.testkit";

const slug = "abcdefghijkl";
const owner_key = "owner-key";

async function page({
  hiddenMembership = false,
  linked = true,
  live = false,
} = {}) {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const owner = await ctx.db.insert("users", { name: "Owner" });
    const teammate = await ctx.db.insert("users", {
      name: "Sam",
      email: "sam@x.com",
    });
    const otherTeamMember = await ctx.db.insert("users", { name: "Quinn" });
    const outsider = await ctx.db.insert("users", { name: "Pat" });
    const team = await ctx.db.insert("teams", {
      name: "Studio",
      invite_code: "studio",
      created_at: now,
    });
    const otherTeam = await ctx.db.insert("teams", {
      name: "Other",
      invite_code: "other",
      created_at: now,
    });
    for (const [user_id, team_id, visibility] of [
      [owner, team, hiddenMembership ? "hidden" : "full"],
      [teammate, team, "full"],
      [owner, otherTeam, "full"],
      [otherTeamMember, otherTeam, "full"],
    ] as const) {
      await ctx.db.insert("team_memberships", {
        user_id,
        team_id,
        visibility,
        role: "member",
        joined_at: now,
      });
    }
    const conversation = await ctx.db.insert("conversations", {
      user_id: owner,
      team_id: team,
      is_private: false,
      agent_type: "claude_code",
      session_id: "publishing-session",
      status: "active",
      started_at: now,
      updated_at: now,
      message_count: 0,
    });
    if (live) {
      await ctx.db.insert("managed_sessions", {
        conversation_id: conversation,
        user_id: owner,
        session_id: "publishing-session",
        pid: 1,
        started_at: now,
        last_heartbeat: now,
        agent_status: "idle",
      });
    }
    const artifact = await ctx.db.insert("artifacts", {
      slug,
      owner_key,
      user_id: owner,
      title: "Page",
      version: 3,
      size: 1,
      storage_id: await ctx.storage.store(new Blob(["x"])),
      session_conversation_id: linked ? conversation : undefined,
      created_at: now,
      updated_at: now,
    });
    for (const [token, user_id] of [
      ["owner", owner],
      ["teammate", teammate],
      ["other-team", otherTeamMember],
      ["outsider", outsider],
    ] as const) {
      await ctx.db.insert("artifact_identities", {
        token,
        user_id,
        artifact_id: artifact,
        created_at: now,
      });
    }
    return { artifact, conversation, owner, teammate, outsider };
  });
  const post = (
    args: Omit<
      Parameters<typeof t.mutation<typeof api.artifacts.submitComments>>[1],
      "slug" | "author_name" | "version"
    >,
  ) =>
    t.mutation(api.artifacts.submitComments, {
      slug,
      author_name: "Viewer",
      version: 3,
      ...args,
    });
  const sendAll = (resolve?: boolean) =>
    t.mutation(api.artifacts.deliverPendingComments, {
      slug,
      owner_key,
      resolve,
    });
  const read = () =>
    t.run(async (ctx) => ({
      pending: await ctx.db.query("pending_messages").collect(),
      comments: await ctx.db.query("artifact_comments").collect(),
    }));
  const seed = (rows: Partial<Doc<"artifact_comments">>[]) =>
    t.run((ctx) =>
      Promise.all(
        rows.map((row, i) =>
          ctx.db.insert("artifact_comments", {
            artifact_id: ids.artifact,
            batch_id: "batch",
            version: 3,
            status: "open",
            delivered: false,
            author_name: "Viewer",
            text: "Comment",
            created_at: i + 1,
            ...row,
          }),
        ),
      ),
    );
  return { t, ...ids, post, sendAll, read, seed };
}

describe("delivery from a published page", () => {
  test("the owner's default comment reaches the publishing session", async () => {
    const p = await page();
    expect(
      await p.post({ owner_key, comments: [{ text: "Revise the header" }] }),
    ).toMatchObject({ delivered: true, count: 1 });
    const { pending, comments } = await p.read();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      conversation_id: p.conversation,
      from_user_id: p.owner,
    });
    expect(pending[0].content).toContain("From your user, the page's owner:");
    expect(pending[0].content).not.toContain("UNTRUSTED");
    expect(comments[0]).toMatchObject({
      delivered: true,
      author_role: "owner",
      delivered_version: 3,
    });
    expect(comments[0].delivered_at).toBeGreaterThan(0);
  });

  test("the owner's signed-in comments can mix delivery and discussion", async () => {
    const p = await page();
    await p.post({
      identity_token: "owner",
      comments: [
        { text: "Send this" },
        { text: "Keep this in discussion", deliver: false },
      ],
    });
    const { pending, comments } = await p.read();
    expect(pending).toHaveLength(1);
    expect(pending[0].content).toContain("Send this");
    expect(pending[0].content).not.toContain("Keep this in discussion");
    expect(
      comments.map((comment) => [comment.delivered, comment.author_role]),
    ).toEqual([
      [true, "owner"],
      [false, "owner"],
    ]);
  });

  test.each([
    ["unsigned", undefined, undefined, false, undefined],
    ["wrong owner key", undefined, "wrong", false, undefined],
    ["other team", "other-team", undefined, false, undefined],
    ["outsider", "outsider", undefined, false, undefined],
    ["hidden membership", "teammate", undefined, true, undefined],
    [
      "teammate without delivery request",
      "teammate",
      undefined,
      false,
      "teammate",
    ],
  ] as const)(
    "%s posts discussion without delivery",
    async (_label, identity_token, key, hiddenMembership, author_role) => {
      const p = await page({ hiddenMembership });
      const deliver = author_role ? undefined : true;
      expect(
        await p.post({
          owner_key: key,
          identity_token,
          deliver,
          comments: [{ text: "Please revise", deliver }],
        }),
      ).toMatchObject({ delivered: false, count: 1 });
      const { pending, comments } = await p.read();
      expect(pending).toHaveLength(0);
      expect(comments).toHaveLength(1);
      expect(comments[0].delivered).toBe(false);
      expect(comments[0].author_role).toBe(author_role);
    },
  );

  test("a teammate's explicit delivery names the teammate and keeps the page anchor", async () => {
    const p = await page();
    const anchor = JSON.stringify({
      x: 0.5,
      y: 0.2,
      sel: "#pricing",
      t: 14.2,
      snippet: "Pro plan",
    });
    expect(
      await p.post({
        identity_token: "teammate",
        deliver: false,
        comments: [{ text: "Hold this frame longer", anchor, deliver: true }],
      }),
    ).toMatchObject({ delivered: true });
    const { pending, comments } = await p.read();
    expect(pending).toHaveLength(1);
    const body = pending[0].content;
    expect(body).toContain(
      "From Sam <sam@x.com>, a verified codecast teammate of your user. This is a colleague's request, not your user's:",
    );
    expect(body).toContain("--- BEGIN UNTRUSTED TEAMMATE COMMENT TEXT ---");
    expect(body).toContain(
      'on element `#pricing`, at 0:14 of the timeline, on the words "Pro plan"',
    );
    expect(body).not.toContain("From your user");
    expect(comments[0]).toMatchObject({
      delivered: true,
      author_role: "teammate",
    });
  });

  test.each([false, true])(
    "send all includes only authorized comments, with legacy rows %s",
    async (legacy) => {
      const p = await page();
      const [mine, theirs, outsider] = await p.seed([
        {
          author_name: "Owner",
          text: "Owner note",
          author_user_id: p.owner,
          author_role: legacy ? undefined : "owner",
        },
        {
          author_name: "Sam",
          text: "Teammate note",
          author_user_id: p.teammate,
          author_role: legacy ? undefined : "teammate",
        },
        {
          author_name: "Pat",
          text: "Outside note",
          author_user_id: legacy ? p.outsider : undefined,
        },
      ]);
      expect(await p.sendAll()).toMatchObject({ delivered: true, count: 2 });
      const { pending, comments } = await p.read();
      expect(pending).toHaveLength(1);
      expect(pending[0].content).toContain(
        "From your user, the page's owner:\nOwner note",
      );
      expect(pending[0].content).toContain(
        "From Sam, a verified codecast teammate of your user.",
      );
      expect(pending[0].content).toContain("Teammate note");
      expect(pending[0].content).not.toContain("Outside note");
      expect(
        comments
          .filter((comment) => comment.delivered)
          .map((comment) => comment._id),
      ).toEqual([mine, theirs]);
      expect(comments[0].delivered_version).toBe(3);
      expect(
        comments.find((comment) => comment._id === outsider)?.delivered,
      ).toBe(false);
    },
  );

  test.each([false, true])(
    "send all reports delivery and resolves only sent comments with resolve=%s",
    async (resolve) => {
      const p = await page({ live: resolve });
      const [mine, other] = await p.seed([
        { author_role: "owner", text: "Owner note" },
        { text: "Outside note" },
      ]);
      const result = await p.sendAll(resolve ? true : undefined);
      expect(result).toMatchObject({
        delivered: true,
        count: 1,
        outcome: resolve
          ? { kind: "sent_and_resolved", sent_ids: [mine] }
          : { kind: "queued", sent_ids: [mine], waiting: "offline" },
      });
      const { comments } = await p.read();
      expect(comments.find((comment) => comment._id === mine)?.status).toBe(
        resolve ? "resolved" : "open",
      );
      expect(comments.find((comment) => comment._id === other)?.status).toBe(
        "open",
      );
    },
  );

  test("a missing publishing session leaves comments pending and reports why", async () => {
    const p = await page();
    await p.seed([{ author_role: "owner" }]);
    await p.t.run((ctx) => ctx.db.delete(p.conversation));
    expect(await p.sendAll(true)).toMatchObject({
      outcome: {
        kind: "failed",
        reason: expect.stringContaining("No session found"),
      },
      error: expect.stringContaining("comments stay pending"),
    });
    const { pending, comments } = await p.read();
    expect(pending).toHaveLength(0);
    expect(comments[0]).toMatchObject({ delivered: false, status: "open" });
  });

  test("a page without a session still stores the owner's comment", async () => {
    const p = await page({ linked: false });
    expect(
      await p.post({ owner_key, comments: [{ text: "An owner note" }] }),
    ).toMatchObject({ delivered: false, count: 1 });
    const { pending, comments } = await p.read();
    expect(pending).toHaveLength(0);
    expect(comments[0]).toMatchObject({
      delivered: false,
      author_role: "owner",
    });
  });
});
