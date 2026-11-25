import { describe, expect, test } from "bun:test";
import type { FunctionArgs } from "convex/server";
import { serverTest } from "../test-helpers/database.testkit";
import { fixtureRows, type NewRow } from "../test-helpers/rows.testkit";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  awaitingSince,
  MAX_COMMENTS_PER_MINUTE,
  MAX_VIEWS_PER_MINUTE,
} from "./artifacts";
import { newSlug, newSecret } from "./lib/slug";
import { lineDiff, accessSummary } from "./lib/artifactRules";
import { kTokenFor, eTokenFor } from "./lib/artifactGates";
import { brandArtifactHtml } from "./artifactPages";
import { pageAgentChip, PAGE_AGENT_PICKUP_MS } from "@codecast/pages/pageAgent";
import { normalizeAssetPath } from "./artifactsHttp";

const SLUG = "abcdefghijkl";
const OWNER_KEY = "sekrit";
const TOKEN = "artifact-owner-token";
const PATH = "/tmp/report.html";
const batch = {
  author_name: "Viewer",
  version: 3,
  comments: [{ text: "nice page" }],
};

async function setup(
  fields: Partial<NewRow<"artifacts">> = {},
  shared = false,
) {
  const t = serverTest();
  const ids = await t.run(async ({ db, storage }) => {
    const rows = fixtureRows(db, "artifact tests");
    const owner = await rows.user({ name: "Owner" });
    const sam = await rows.user({
      name: "Sam",
      github_username: "sam",
      github_avatar_url: "https://av/sam.png",
      email: "sam@example.com",
    });
    const riley = await rows.user({
      name: "Riley",
      github_username: "riley",
      image: "https://av/riley.png",
    });
    await rows.token(owner, TOKEN);
    const conversation = await rows.conversation(owner);
    let task;
    if (shared) {
      const team = await rows.team();
      await rows.membership(owner, team);
      await rows.membership(sam, team);
      await rows.membership(riley, team);
      task = await rows.task(owner, {
        team_id: team,
        workspace: `team:${team}`,
      });
    }
    const blob = await storage.store(new Blob(["Published page"]));
    const incoming = await storage.store(new Blob(["Incoming page"]));
    const page = await rows.artifact(owner, blob, {
      slug: SLUG,
      title: "Old title",
      size: 100,
      version: 3,
      owner_key: OWNER_KEY,
      source_path: PATH,
      created_at: 1000,
      updated_at: 2000,
      session_conversation_id: conversation,
      task_id: task,
      ...fields,
    });
    if (shared)
      await db.insert("artifact_identities", {
        token: "tok-sam",
        user_id: sam,
        artifact_id: page,
        created_at: 1,
      });
    return { owner, sam, riley, page, blob, incoming };
  });
  return {
    t,
    ...ids,
    publish: (
      fields: Partial<
        FunctionArgs<typeof internal.artifacts.upsertFromPublish>
      > = {},
    ) =>
      t.mutation(internal.artifacts.upsertFromPublish, {
        user_id: ids.owner,
        storage_id: ids.incoming,
        title: "Report",
        size: 10,
        source_path: PATH,
        ...fields,
      }),
    remove: (target: string) =>
      t.mutation(api.artifacts.deleteFromCLI, { api_token: TOKEN, target }),
    submit: (
      args: Partial<FunctionArgs<typeof api.artifacts.submitComments>> = {},
    ) =>
      t.mutation(api.artifacts.submitComments, {
        slug: SLUG,
        ...batch,
        ...args,
      }),
    view: (k?: string) =>
      t.mutation(api.artifacts.recordView, { slug: SLUG, k }),
    read: () => t.run(({ db }) => db.get(ids.page)),
    pages: () => t.run(({ db }) => db.query("artifacts").collect()),
    history: () =>
      t.run(({ db }) =>
        db
          .query("artifact_versions")
          .withIndex("by_artifact", (q) => q.eq("artifact_id", ids.page))
          .collect(),
      ),
    stored: (id: Id<"_storage">) => t.run(({ db }) => db.system.get(id)),
    comments: () => t.run(({ db }) => db.query("artifact_comments").collect()),
    notes: () => t.run(({ db }) => db.query("notifications").collect()),
    views: () => t.run(({ db }) => db.query("artifact_stats").collect()),
    budgets: () => t.run(({ db }) => db.query("rate_limits").collect()),
    priorComment: (fields: Partial<NewRow<"artifact_comments">> = {}) =>
      t.run(({ db }) =>
        db.insert("artifact_comments", {
          artifact_id: ids.page,
          batch_id: "prior",
          author_name: "Sam",
          author_user_id: ids.sam,
          text: "first",
          version: 3,
          status: "open",
          delivered: false,
          created_at: 10,
          ...fields,
        }),
      ),
  };
}

describe("newSlug", () => {
  test("is 12 chars of url-safe base62", () => {
    for (let i = 0; i < 20; i++) {
      expect(newSlug()).toMatch(/^[A-Za-z0-9]{12}$/);
    }
  });

  test("newSecret is longer than a slug", () => {
    expect(newSecret()).toMatch(/^[A-Za-z0-9]{20}$/);
  });
});

describe("lineDiff", () => {
  test("equal texts produce only eq ops", () => {
    const { ops, truncated } = lineDiff("a\nb\nc", "a\nb\nc");
    expect(truncated).toBe(false);
    expect(ops.every((o) => o.t === "eq")).toBe(true);
    expect(ops.length).toBe(3);
  });

  test("a changed middle line yields del+add with stable context", () => {
    const { ops } = lineDiff("a\nb\nc", "a\nX\nc");
    expect(ops.map((o) => o.t)).toEqual(["eq", "del", "add", "eq"]);
    expect(ops[1].line).toBe("b");
    expect(ops[2].line).toBe("X");
  });

  test("pure insertion is adds only", () => {
    const { ops } = lineDiff("a\nc", "a\nb\nc");
    expect(ops.filter((o) => o.t === "add").map((o) => o.line)).toEqual(["b"]);
    expect(ops.filter((o) => o.t === "del").length).toBe(0);
  });

  test("caps pathological inputs", () => {
    const big = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
    const { truncated } = lineDiff(big, "other");
    expect(truncated).toBe(true);
  });
});

describe("normalizeAssetPath", () => {
  test("accepts clean relative paths", () => {
    expect(normalizeAssetPath("img/chart.png")).toBe("img/chart.png");
    expect(normalizeAssetPath("./css/app.css")).toBe("css/app.css");
    expect(normalizeAssetPath("a\\b\\c.js")).toBe("a/b/c.js");
  });

  test("rejects traversal, absolute, and reserved paths", () => {
    expect(normalizeAssetPath("../etc/passwd")).toBeNull();
    expect(normalizeAssetPath("/abs.js")).toBeNull();
    expect(normalizeAssetPath("_v/3/x.png")).toBeNull();
    expect(normalizeAssetPath("a/../b.js")).toBeNull();
  });
});

describe("upsertFromPublish", () => {
  test("republishing the same path updates in place and snapshots the old version", async () => {
    const c = await setup();
    const result = await c.publish({
      title: "New title",
      size: 200,
      content_hash: "hash_new",
    });
    expect(result).toMatchObject({ slug: SLUG, updated: true, version: 4 });
    expect(result.url).toContain(`/a/${SLUG}`);
    expect(await c.stored(c.blob)).not.toBeNull();
    const history = await c.history();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      artifact_id: c.page,
      version: 3,
      title: "Old title",
      storage_id: c.blob,
      size: 100,
      published_at: 2000,
    });
    expect(await c.read()).toMatchObject({
      storage_id: c.incoming,
      title: "New title",
      size: 200,
      version: 4,
      content_hash: "hash_new",
    });
  });

  test("byte-identical republish is a no-op that drops the new blob", async () => {
    const c = await setup({ content_hash: "same" });
    const before = await c.read();
    const result = await c.publish({
      title: "New title",
      size: 100,
      content_hash: "same",
    });
    expect(result).toMatchObject({ version: 3, unchanged: true });
    expect(await c.stored(c.incoming)).toBeNull();
    expect(await c.stored(c.blob)).not.toBeNull();
    expect(await c.read()).toEqual(before);
    expect(await c.history()).toEqual([]);
  });

  test("history beyond the cap prunes the oldest snapshots", async () => {
    const c = await setup({ version: 22 });
    const versions = await c.t.run(async ({ db, storage }) => {
      const ids = [];
      for (let version = 1; version <= 21; version++) {
        const blob = await storage.store(new Blob([`Version ${version}`]));
        ids.push({
          blob,
          id: await db.insert("artifact_versions", {
            artifact_id: c.page,
            version,
            title: `T${version}`,
            storage_id: blob,
            size: 10,
            published_at: 999 + version,
          }),
        });
      }
      return ids;
    });
    await c.publish({ title: "New", size: 5, content_hash: "h" });
    expect((await c.history()).map((row) => row.version)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 3),
    );
    for (const { id, blob } of versions.slice(0, 2)) {
      expect(await c.t.run(({ db }) => db.get(id))).toBeNull();
      expect(await c.stored(blob)).toBeNull();
    }
    for (const { blob } of versions.slice(2))
      expect(await c.stored(blob)).not.toBeNull();
    expect(await c.stored(c.blob)).not.toBeNull();
  });

  test("a different user's identical path creates a separate artifact", async () => {
    const c = await setup();
    const result = await c.publish({ user_id: c.sam, title: "Mine", size: 50 });
    expect(result).toMatchObject({ updated: false, version: 1 });
    expect(await c.pages()).toHaveLength(2);
    expect(await c.stored(c.blob)).not.toBeNull();
    expect(await c.stored(c.incoming)).not.toBeNull();
  });

  test("force_new mints a fresh slug even when the path matches", async () => {
    const c = await setup();
    const result = await c.publish({
      title: "Again",
      size: 10,
      force_new: true,
    });
    expect(result.updated).toBe(false);
    expect(result.slug).not.toBe(SLUG);
    expect(await c.pages()).toHaveLength(2);
  });

  test("no source_path always creates", async () => {
    const c = await setup();
    const result = await c.publish({
      title: "Pathless",
      size: 10,
      source_path: undefined,
    });
    expect(result.updated).toBe(false);
    expect(await c.pages()).toHaveLength(2);
  });
});

describe("version rows (historyBySlug / ownerPanel)", () => {
  async function versions() {
    const c = await setup({ kind: "markdown" });
    const blobs = await c.t.run(async ({ db, storage }) => {
      const source = await storage.store(new Blob(["Current source"]));
      const first = await storage.store(new Blob(["Version 1"]));
      const firstSource = await storage.store(new Blob(["Version 1 source"]));
      const second = await storage.store(new Blob(["Version 2"]));
      await db.patch(c.page, { source_storage_id: source });
      await db.insert("artifact_versions", {
        artifact_id: c.page,
        version: 1,
        title: "T1",
        size: 10,
        published_at: 1100,
        storage_id: first,
        source_storage_id: firstSource,
        edited_by: "link editor",
      });
      await db.insert("artifact_versions", {
        artifact_id: c.page,
        version: 2,
        title: "T2",
        size: 20,
        published_at: 1200,
        storage_id: second,
        kind: "html",
      });
      return { source, first, firstSource, second };
    });
    return { ...c, ...blobs };
  }

  test("historyBySlug pins the shared row shape + storage ids + kind fallback chain", async () => {
    const c = await versions();
    const out = await c.t.query(internal.artifacts.historyBySlug, {
      slug: SLUG,
    });
    expect(out?.versions).toEqual([
      {
        version: 3,
        title: "Old title",
        size: 100,
        published_at: 2000,
        edited_by: null,
        storage_id: c.blob,
        source_storage_id: c.source,
        kind: "markdown",
      },
      {
        version: 2,
        title: "T2",
        size: 20,
        published_at: 1200,
        edited_by: null,
        storage_id: c.second,
        kind: "html",
      },
      {
        version: 1,
        title: "T1",
        size: 10,
        published_at: 1100,
        edited_by: "link editor",
        storage_id: c.first,
        source_storage_id: c.firstSource,
        kind: "markdown",
      },
    ]);
  });

  test("ownerPanel pins the same rows with the current flag", async () => {
    const c = await versions();
    const out = await c.t.query(internal.artifacts.ownerPanel, {
      slug: SLUG,
      owner_key: OWNER_KEY,
    });
    expect(out?.versions).toEqual([
      {
        version: 3,
        title: "Old title",
        size: 100,
        published_at: 2000,
        edited_by: null,
        current: true,
      },
      {
        version: 2,
        title: "T2",
        size: 20,
        published_at: 1200,
        edited_by: null,
        current: false,
      },
      {
        version: 1,
        title: "T1",
        size: 10,
        published_at: 1100,
        edited_by: "link editor",
        current: false,
      },
    ]);
  });
});

describe("deleteFromCLI", () => {
  test("delete also removes history rows and their blobs", async () => {
    const c = await setup();
    const historyBlob = await c.t.run(async ({ db, storage }) => {
      const blob = await storage.store(new Blob(["Old"]));
      await db.insert("artifact_versions", {
        artifact_id: c.page,
        version: 2,
        title: "Old",
        storage_id: blob,
        size: 10,
        published_at: 1500,
      });
      return blob;
    });
    expect(await c.remove(SLUG)).toMatchObject({ deleted: { slug: SLUG } });
    expect(await c.read()).toBeNull();
    expect(await c.history()).toEqual([]);
    expect(await c.stored(c.blob)).toBeNull();
    expect(await c.stored(historyBlob)).toBeNull();
  });

  test("deletes by path basename when unambiguous", async () => {
    const c = await setup();
    expect(await c.remove("report.html")).toMatchObject({
      deleted: { slug: SLUG },
    });
    expect(await c.read()).toBeNull();
  });

  test("ambiguous basename returns an error naming the candidates", async () => {
    const c = await setup();
    await c.publish({
      slug: "zzzzzzzzzzzz",
      title: "Second",
      source_path: "/home/x/report.html",
    });
    const before = await c.pages();
    const result = await c.remove("report.html");
    expect(result.error).toContain("matches 2 artifacts");
    expect(result.error).toContain("zzzzzzzzzzzz");
    expect(await c.pages()).toEqual(before);
  });

  test("no match returns an error", async () => {
    const c = await setup();
    expect((await c.remove("nope")).error).toContain("No page matches");
  });
});

describe("comment discussion gating", () => {
  test("a viewer's comment is stored as discussion, never delivered", async () => {
    const c = await setup();
    expect(await c.submit()).toMatchObject({
      delivered: false,
      count: 1,
      as: null,
    });
    const comments = await c.comments();
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ text: "nice page", delivered: false });
  });

  test("an anonymous comment notifies the owner, with the viewer name and a deep link", async () => {
    const c = await setup();
    await c.submit();
    const notes = await c.notes();
    const [comment] = await c.comments();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      type: "artifact_commented",
      entity_type: "artifact",
      entity_id: SLUG,
      actor_name: "Viewer",
      recipient_user_id: c.owner,
    });
    expect(notes[0].actor_user_id).toBeUndefined();
    expect(notes[0].link).toContain(`/a/${SLUG}?c=${comment._id}`);
  });

  test("comments off rejects new posts", async () => {
    const c = await setup({ comments_disabled: true });
    expect((await c.submit()).error).toContain("Comments are off");
    expect(await c.comments()).toEqual([]);
    expect(await c.budgets()).toEqual([]);
  });

  test("send-all is owner-only", async () => {
    const c = await setup();
    const noKey = await c.t.mutation(api.artifacts.deliverPendingComments, {
      slug: SLUG,
    });
    expect(noKey.error).toContain("owner");
    const wrongKey = await c.t.mutation(api.artifacts.deliverPendingComments, {
      slug: SLUG,
      owner_key: "wrong",
    });
    expect(wrongKey.error).toContain("owner");
    expect(wrongKey.outcome).toEqual({
      kind: "failed",
      reason: wrongKey.error,
    });
  });
});

describe("comment identity, threads, and notifications", () => {
  test("a valid identity token stamps the account's name/avatar/user onto the comment", async () => {
    const c = await setup({}, true);
    const result = await c.submit({
      author_name: "Spoofed Name",
      identity_token: "tok-sam",
      comments: [{ text: "love this" }],
    });
    expect(result.as).toEqual({ name: "Sam", avatar: "https://av/sam.png" });
    expect((await c.comments())[0]).toMatchObject({
      author_name: "Sam",
      author_user_id: c.sam,
      author_avatar: "https://av/sam.png",
      author_email: "sam@example.com",
    });
  });

  test("a bad identity token degrades to the viewer-typed name", async () => {
    const c = await setup({}, true);
    const result = await c.submit({
      author_name: "Drive-by",
      identity_token: "tok-forged",
      comments: [{ text: "hello" }],
    });
    expect(result.as).toBeNull();
    const [comment] = await c.comments();
    expect(comment.author_name).toBe("Drive-by");
    expect(comment.author_user_id).toBeUndefined();
  });

  test("a teammate's comment notifies the owner as that account", async () => {
    const c = await setup({}, true);
    await c.submit({
      author_name: "",
      identity_token: "tok-sam",
      comments: [{ text: "shipping it" }],
    });
    const notes = await c.notes();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      type: "artifact_commented",
      actor_user_id: c.sam,
      recipient_user_id: c.owner,
    });
  });

  test("@mentions from a verified teammate notify the mentioned teammate, once", async () => {
    const c = await setup({}, true);
    await c.submit({
      author_name: "",
      identity_token: "tok-sam",
      comments: [{ text: "@riley what do you think? cc @riley" }],
    });
    const notes = await c.notes();
    const mentions = notes.filter((note) => note.type === "mention");
    expect(mentions).toHaveLength(1);
    expect(mentions[0]).toMatchObject({
      recipient_user_id: c.riley,
      actor_user_id: c.sam,
    });
    expect(mentions[0].message).toContain("Sam mentioned you");
    expect(
      notes.some(
        (note) =>
          note.type === "artifact_commented" &&
          note.recipient_user_id === c.owner,
      ),
    ).toBe(true);
  });

  test("@mentions from an anonymous viewer are ignored", async () => {
    const c = await setup({}, true);
    await c.submit({
      author_name: "Rando",
      comments: [{ text: "@riley spam spam" }],
    });
    const notes = await c.notes();
    expect(notes.filter((note) => note.type === "mention")).toHaveLength(0);
    expect(
      notes.filter((note) => note.type === "artifact_commented"),
    ).toHaveLength(1);
  });

  test("replies thread under the top-level comment and notify its author", async () => {
    const c = await setup({}, true);
    const parent = await c.priorComment();
    const result = await c.submit({
      author_name: "Guest",
      parent_id: parent,
      comments: [{ text: "agreed!" }],
    });
    expect(result.count).toBe(1);
    const comments = await c.comments();
    expect(comments).toHaveLength(2);
    expect(comments[1]).toMatchObject({
      parent_comment_id: parent,
      text: "agreed!",
    });
    const notes = await c.notes();
    const replies = notes.filter((note) => note.type === "comment_reply");
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      recipient_user_id: c.sam,
      actor_name: "Guest",
    });
    expect(replies[0].link).toContain(`?c=${parent}`);
    expect(
      notes.some(
        (note) =>
          note.type === "artifact_commented" &&
          note.recipient_user_id === c.owner,
      ),
    ).toBe(true);
  });

  test("replying to a reply attaches to the thread's top-level comment", async () => {
    const c = await setup({}, true);
    const top = await c.priorComment({ author_name: "A", text: "top" });
    const middle = await c.priorComment({
      author_name: "B",
      text: "mid",
      parent_comment_id: top,
    });
    await c.submit({
      author_name: "C",
      parent_id: middle,
      comments: [{ text: "deep" }],
    });
    const comments = await c.comments();
    expect(comments).toHaveLength(3);
    expect(comments[2]).toMatchObject({ parent_comment_id: top });
  });

  test("a reply to a missing comment is rejected", async () => {
    const c = await setup({}, true);
    const parent = await c.priorComment();
    await c.t.run(({ db }) => db.delete(parent));
    expect(
      (
        await c.submit({
          author_name: "C",
          parent_id: parent,
          comments: [{ text: "hi" }],
        })
      ).error,
    ).toContain("gone");
    expect(await c.comments()).toEqual([]);
    expect(await c.budgets()).toEqual([]);
  });

  test("the owner commenting via owner_key does not notify themselves", async () => {
    const c = await setup({}, true);
    await c.submit({
      author_name: "Owner",
      owner_key: OWNER_KEY,
      deliver: false,
      comments: [{ text: "note to self" }],
    });
    expect(await c.comments()).toHaveLength(1);
    expect(await c.notes()).toHaveLength(0);
  });
});

describe("agent state on the page", () => {
  test("awaiting_since is the newest send no newer version has answered, keyed off versions", () => {
    const sent = (at: number, on: number) => ({
      delivered: true,
      delivered_at: at,
      delivered_version: on,
      version: on,
    });
    expect(
      awaitingSince(
        [sent(50, 2), sent(120, 3), sent(110, 3), { version: 3 }],
        3,
      ),
    ).toBe(120);
    // A newer version answers every earlier send, whatever the clocks say.
    expect(awaitingSince([sent(500, 2)], 3)).toBeNull();
    // Rows from before delivered_version fall back to the version they were made on.
    expect(
      awaitingSince([{ delivered: true, delivered_at: 9, version: 3 }], 3),
    ).toBe(9);
    expect(awaitingSince([], 3)).toBeNull();
  });

  test("the chip: needs input wins, a send reads as updating until picked up or answered", () => {
    const now = 1_000_000;
    expect(pageAgentChip("needs_input", now - 1, now)).toBe("needs_input");
    expect(pageAgentChip("working", now - 600_000, now)).toBe("updating");
    expect(pageAgentChip("done", now - 10_000, now)).toBe("updating");
    expect(pageAgentChip("done", now - PAGE_AGENT_PICKUP_MS - 1, now)).toBe(
      "idle",
    );
    expect(pageAgentChip("working", null, now)).toBe("working");
    expect(pageAgentChip("dormant", null, now)).toBe("idle");
  });
});

describe("comment gates on the public mutation", () => {
  test("an expired page takes no anonymous comment", async () => {
    const c = await setup({ expires_at: 500 });
    expect((await c.submit()).error).toContain("expired");
    expect(await c.comments()).toEqual([]);
    expect(await c.notes()).toEqual([]);
  });

  test.each(["missing", "wrong", "valid"])(
    "a password wall handles a %s unlock token",
    async (kind) => {
      const c = await setup({ password_hash: "ph" });
      const k =
        kind === "valid"
          ? await kTokenFor("ph", SLUG)
          : kind === "wrong"
            ? "nope"
            : undefined;
      const result = await c.submit({ k });
      if (kind === "valid") {
        expect(result).toMatchObject({ count: 1 });
        expect(await c.comments()).toHaveLength(1);
      } else {
        expect(result.error).toContain("password");
        expect(await c.comments()).toEqual([]);
      }
    },
  );

  test("the owner key clears the gate — the owner is not a locked-out viewer", async () => {
    const c = await setup({ password_hash: "ph" });
    expect(
      await c.submit({ owner_key: OWNER_KEY, deliver: false }),
    ).toMatchObject({ count: 1 });
    expect(await c.comments()).toHaveLength(1);
  });

  test("an email-walled page needs the email token", async () => {
    const c = await setup({ email_gate: true });
    expect((await c.submit()).error).toContain("email");
    expect(await c.comments()).toEqual([]);
    const e = await eTokenFor(OWNER_KEY, SLUG);
    expect(await c.submit({ e })).toMatchObject({ count: 1 });
  });

  test("the flood limit is enforced by the mutation, in the same transaction as the insert", async () => {
    const c = await setup();
    for (let i = 0; i < MAX_COMMENTS_PER_MINUTE; i++) await c.submit();
    for (let i = 0; i < 3; i++)
      expect((await c.submit()).error).toContain("Too many");
    expect(await c.comments()).toHaveLength(MAX_COMMENTS_PER_MINUTE);
  });

  test("an idempotent retry does not spend flood budget", async () => {
    const c = await setup();
    const args = { client_id: "same" };
    const first = await c.submit(args);
    const before = await c.budgets();
    for (let i = 0; i < MAX_COMMENTS_PER_MINUTE + 5; i++)
      expect(await c.submit(args)).toEqual(first);
    expect(await c.comments()).toHaveLength(1);
    expect(await c.budgets()).toEqual(before);
  });
});

describe("view beacon gates", () => {
  test("a password-walled page does not count a view without the token", async () => {
    const c = await setup({ password_hash: "ph" });
    expect(await c.view()).toEqual({ ok: false });
    expect(await c.views()).toEqual([]);
    expect(await c.budgets()).toEqual([]);
  });

  test("the unlock token counts the view", async () => {
    const c = await setup({ password_hash: "ph" });
    expect(await c.view(await kTokenFor("ph", SLUG))).toEqual({ ok: true });
    const views = await c.views();
    expect(views).toHaveLength(1);
    expect(views[0].view_count).toBe(1);
  });

  test("an expired page counts nothing", async () => {
    const c = await setup({ expires_at: 500 });
    expect(await c.view()).toEqual({ ok: false });
    expect(await c.views()).toEqual([]);
    expect(await c.budgets()).toEqual([]);
  });

  test("the counter is bounded per minute", async () => {
    const c = await setup();
    for (let i = 0; i < MAX_VIEWS_PER_MINUTE + 10; i++) await c.view();
    const views = await c.views();
    expect(views).toHaveLength(1);
    expect(views[0].view_count).toBe(MAX_VIEWS_PER_MINUTE);
  });
});

describe("brandArtifactHtml", () => {
  const opts = {
    title: "Q3 <Report>",
    author: "Ashot",
    updatedAt: 1700000000000,
    shareUrl: "https://codecast.sh/a/x1",
  };

  test("injects the bar after <body> and og meta after <head>", () => {
    const out = brandArtifactHtml(
      '<html><head><title>T</title></head><body class="x"><h1>hi</h1></body></html>',
      opts,
    );
    expect(out.indexOf("og:title")).toBeGreaterThan(out.indexOf("<head>"));
    expect(out.indexOf("og:title")).toBeLessThan(out.indexOf("<title>"));
    expect(out.indexOf("__cc_bar")).toBeGreaterThan(out.indexOf("<body"));
    expect(out.indexOf('id="__cc_bar"')).toBeLessThan(out.indexOf("<h1>"));
    expect(out).toContain("<title>T</title>");
  });

  test("escapes the title everywhere it appears", () => {
    const out = brandArtifactHtml("<body></body>", opts);
    expect(out).toContain("Q3 &lt;Report&gt;");
    expect(out).not.toContain("Q3 <Report>");
  });

  test("prepends the bar when there is no body tag", () => {
    const out = brandArtifactHtml("<div>fragment</div>", opts);
    expect(out.startsWith('\n<style id="__cc_style">')).toBe(true);
    expect(out).toContain("<div>fragment</div>");
    expect(out).not.toContain("og:title");
  });

  test("always renders the minimize control and the restore pill", () => {
    const out = brandArtifactHtml("<body></body>", opts);
    expect(out).toContain('id="__cc_hide"');
    expect(out).toContain('id="__cc_pill"');
  });

  test("a framed page starts minimized unless the viewer restored the bar", () => {
    // Embeds (conversation, decision queue) frame the page and supply their
    // own chrome; the bar collapses into the corner pill by default there.
    const out = brandArtifactHtml("<body></body>", opts);
    expect(out).toContain("framed=window.self!==window.top");
    expect(out).toContain('(framed&&minPref!=="0"))setMin(true,false)');
    // The framed default is not persisted; only a click is remembered.
    expect(out).toContain("setMin(false,true)");
  });

  test("session chip renders only when a session is exposed", () => {
    const shown = brandArtifactHtml("<body></body>", {
      ...opts,
      sessionShortId: "jx1abcd",
      sessionTitle: "My session",
    });
    expect(shown).toContain('class="__cc_sess"');
    expect(shown).toContain("My session");
    const hidden = brandArtifactHtml("<body></body>", {
      ...opts,
      sessionShortId: null,
    });
    expect(hidden).not.toContain('class="__cc_sess"');
  });

  test("session chip links the full conversation id, never the colliding short id", () => {
    const full = "jx7etg8nap9wz7zt0npak20tax8f3k33";
    const out = brandArtifactHtml("<body></body>", {
      ...opts,
      sessionShortId: "jx7etg8",
      sessionConversationId: full,
      sessionTitle: "T",
    });
    expect(out).toContain(`href="https://codecast.sh/conversation/${full}"`);
    // A row published before the id was stored still links something.
    const legacy = brandArtifactHtml("<body></body>", {
      ...opts,
      sessionShortId: "jx7etg8",
      sessionTitle: "T",
    });
    expect(legacy).toContain('href="https://codecast.sh/conversation/jx7etg8"');
  });

  test("accessSummary reports the session-link toggle", () => {
    const base = {
      password_hash: undefined,
      email_gate: undefined,
      expires_at: undefined,
      edit_mode: undefined,
    };
    expect(accessSummary({ ...base } as never).show_session).toBe(true);
    expect(
      accessSummary({ ...base, hide_session: true } as never).show_session,
    ).toBe(false);
  });

  test("carries the share url into the bar config (no copy button on the bar)", () => {
    const out = brandArtifactHtml("<body></body>", opts);
    expect(out).toContain('"shareUrl":"https://codecast.sh/a/x1"');
    expect(out).not.toContain('id="__cc_copy"');
  });

  test("without metaUrl there is no version chip and no polling config", () => {
    const out = brandArtifactHtml("<body></body>", opts);
    expect(out).not.toContain('id="__cc_ver"');
    expect(out).toContain('"metaUrl":""');
  });

  test("with metaUrl renders the version chip and embeds versions for the script", () => {
    const out = brandArtifactHtml("<body></body>", {
      ...opts,
      version: 5,
      currentVersion: 5,
      metaUrl: "https://convex.codecast.sh/cli/a/x1?meta=1",
    });
    expect(out).toContain('id="__cc_ver"');
    expect(out).toContain(">v5 <svg");
    expect(out).toContain(
      '"metaUrl":"https://convex.codecast.sh/cli/a/x1?meta=1"',
    );
    expect(out).toContain('"version":5');
    expect(out).toContain('"currentVersion":5');
    expect(out).not.toContain('id="__cc_latest"');
  });

  test("an old version shows the old marker and the latest link", () => {
    const out = brandArtifactHtml("<body></body>", {
      ...opts,
      version: 2,
      currentVersion: 5,
      metaUrl: "https://convex.codecast.sh/cli/a/x1?meta=1",
    });
    expect(out).toContain(">v2 (old) <svg");
    expect(out).toContain('id="__cc_latest"');
  });

  test("comment chip shows the open count and embeds it in the config", () => {
    const out = brandArtifactHtml("<body></body>", {
      ...opts,
      metaUrl: "https://convex.codecast.sh/cli/a/x1?meta=1",
      commentCount: 3,
    });
    expect(out).toContain('id="__cc_ccount"');
    expect(out).toContain(">3</span>");
    expect(out).toContain('"comments":3');
  });

  test("zero comments renders an empty chip and a zero config count", () => {
    const out = brandArtifactHtml("<body></body>", {
      ...opts,
      metaUrl: "https://convex.codecast.sh/cli/a/x1?meta=1",
      commentCount: 0,
    });
    expect(out).toContain('id="__cc_ccount"></span>');
    expect(out).toContain('"comments":0');
  });

  test("interactive bar ships the comments, manage, and history panels", () => {
    const out = brandArtifactHtml("<body></body>", {
      ...opts,
      metaUrl: "https://convex.codecast.sh/cli/a/x1?meta=1",
    });
    expect(out).toContain('id="__cc_cpanel"');
    expect(out).toContain('id="__cc_mgr"');
    expect(out).toContain('id="__cc_hist"');
    expect(out).toContain("/cli/artifacts/comment");
    expect(out).toContain("/cli/artifacts/manage");
  });

  test("the agent chip ships only on a page with a publishing session, and the script parses", () => {
    const meta = {
      ...opts,
      metaUrl: "https://convex.codecast.sh/cli/a/x1?meta=1",
    };
    const withAgent = brandArtifactHtml("<body></body>", {
      ...meta,
      hasAgent: true,
    });
    expect(withAgent).toContain('id="__cc_agent"');
    expect(withAgent).toContain('"hasAgent":true');
    expect(brandArtifactHtml("<body></body>", meta)).not.toContain(
      'id="__cc_agent"',
    );
    const script = withAgent.match(
      /<script>\(function\(\)\{([\s\S]*?)\}\)\(\);<\/script>/,
    );
    expect(() => new Function(script![1])).not.toThrow();
  });

  test("mobile styles include bottom and left safe-area padding", () => {
    const out = brandArtifactHtml("<body></body>", opts);
    expect(out).toContain("env(safe-area-inset-bottom)");
    expect(out).toContain("env(safe-area-inset-left)");
  });

  test("bar inline script parses as valid JavaScript", () => {
    const out = brandArtifactHtml("<body></body>", {
      ...opts,
      version: 2,
      currentVersion: 3,
      metaUrl: "https://convex.codecast.sh/cli/a/x1?meta=1",
      commentCount: 2,
    });
    const scripts = [...out.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
      (m) => m[1],
    );
    expect(scripts.length).toBeGreaterThan(0);
    for (const src of scripts) expect(() => new Function(src)).not.toThrow();
  });

  // The mutation re-checks the gates, so the page has to hand them back. If
  // this wiring is dropped, every comment and view on a gated page is refused.
  test("the bar echoes the gate tokens it was served with on every write", () => {
    const out = brandArtifactHtml("<body></body>", {
      ...opts,
      metaUrl: "https://convex.codecast.sh/cli/a/x1?meta=1&k=tok",
      commentsEnabled: true,
    });
    expect(out).toContain('var gateK=qs.get("k")||"";');
    expect(out).toContain('var gateE=qs.get("e")||"";');
    // The view beacon and both comment paths (new batch, threaded reply).
    expect([
      ...out.matchAll(/k:gateK\|\|undefined,e:gateE\|\|undefined/g),
    ]).toHaveLength(3);
  });
});
