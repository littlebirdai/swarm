// The phone's page screen reads a page's discussion through discussionForApp
// and resolves through setCommentStatusForApp. A reader the page admits sees
// its open comments; the owner sees the resolved ones too; a gated page shows
// nothing to a reader without its keys; only the owner flips a comment.
import { describe, expect, test } from "bun:test";
import { asUser, serverTest } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import { api } from "./_generated/api";

async function setup() {
  const t = serverTest();
  const ids = await t.run(async ({ db, storage }) => {
    const rows = fixtureRows(db, "page discussion");
    const owner = await rows.user();
    const viewer = await rows.user();
    const blob = await storage.store(new Blob(["page"]));
    const page = await rows.artifact(owner, blob, {
      slug: "openpage",
      title: "Open",
    });
    await rows.artifact(owner, blob, {
      slug: "lockedpage",
      password_hash: "h",
    });

    const common = {
      artifact_id: page,
      batch_id: "discussion",
      author_name: "V",
      version: 1,
      delivered: false,
    };
    const open = await db.insert("artifact_comments", {
      ...common,
      author_email: "v@x.org",
      text: "open one",
      status: "open",
      created_at: 2,
    });
    const resolved = await db.insert("artifact_comments", {
      ...common,
      text: "done one",
      status: "resolved",
      created_at: 1,
    });
    return { owner, viewer, page, open, resolved };
  });
  return { t, ...ids, readComment: () => t.run(({ db }) => db.get(ids.open)) };
}

describe("discussionForApp", () => {
  test("the owner sees every comment oldest first, emails stripped, in the pageThreads row shape", async () => {
    const { t, owner, page, open, resolved } = await setup();
    const got = (await asUser(t, owner).query(api.artifacts.discussionForApp, {
      slug: "openpage",
    }))!;
    expect(got).toMatchObject({
      _id: page,
      slug: "openpage",
      title: "Open",
      user_id: owner,
      comments_disabled: false,
    });
    expect(got.comments.map((c) => c._id)).toEqual([resolved, open]);
    expect(got.comments.every((c) => !("author_email" in c))).toBe(true);
  });

  test("another reader of an open page sees only its open comments", async () => {
    const { t, viewer, open } = await setup();
    const got = (await asUser(t, viewer).query(api.artifacts.discussionForApp, {
      slug: "openpage",
    }))!;
    expect(got.comments.map((c) => c._id)).toEqual([open]);
  });

  test("a gated page without keys, a missing page, or no sign-in returns null", async () => {
    const { t, viewer } = await setup();
    const signedIn = asUser(t, viewer);
    expect(
      await signedIn.query(api.artifacts.discussionForApp, {
        slug: "lockedpage",
      }),
    ).toBeNull();
    expect(
      await signedIn.query(api.artifacts.discussionForApp, { slug: "nope" }),
    ).toBeNull();
    expect(
      await t.query(api.artifacts.discussionForApp, { slug: "openpage" }),
    ).toBeNull();
  });
});

describe("setCommentStatusForApp", () => {
  test("the owner resolves and reopens", async () => {
    const { t, owner, open, readComment } = await setup();
    const signedIn = asUser(t, owner);
    await signedIn.mutation(api.artifacts.setCommentStatusForApp, {
      comment_id: open,
      resolved: true,
    });
    expect((await readComment())?.status).toBe("resolved");
    await signedIn.mutation(api.artifacts.setCommentStatusForApp, {
      comment_id: open,
      resolved: false,
    });
    expect((await readComment())?.status).toBe("open");
  });

  test("anyone else is refused", async () => {
    const { t, viewer, open, readComment } = await setup();
    await expect(
      asUser(t, viewer).mutation(api.artifacts.setCommentStatusForApp, {
        comment_id: open,
        resolved: true,
      }),
    ).rejects.toThrow("Only the page owner");
    expect((await readComment())?.status).toBe("open");
  });
});
