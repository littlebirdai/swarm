// ownerUnlock opens a gated page inside the app for its owner and for whoever
// may read the decision the page was filed on (a trial gates its decision
// pages because they quote a customer; the decision's own readers still read
// them). Nobody else gets the tokens, and a decision opens only the pages it
// filed. embedInfo carries the same rule for an embed, one row per page.
import { describe, expect, test } from "bun:test";
import type { FunctionArgs } from "convex/server";
import { asUser, serverTest } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import { api } from "./_generated/api";
import { kTokenFor } from "./lib/artifactGates";

async function setup() {
  const t = serverTest();
  const ids = await t.run(async ({ db, storage }) => {
    const rows = fixtureRows(db, "page unlock");
    const owner = await rows.user();
    const asked = await rows.user();
    const stranger = await rows.user();
    const blob = await storage.store(new Blob(["page"]));
    await rows.artifact(owner, blob, {
      slug: "trialpage",
      title: "The fix",
      version: 2,
      password_hash: "h1",
    });
    await rows.artifact(owner, blob, {
      slug: "otherpage",
      password_hash: "h2",
    });
    await rows.artifact(owner, blob, {
      slug: "openpage",
      title: "Open",
      version: 4,
    });
    const sessionId = "private-trial-session";
    const conversation = await rows.conversation(owner, {
      session_id: sessionId,
      is_private: true,
    });
    const common = {
      user_id: owner,
      conversation_id: conversation,
      session_id: sessionId,
      question: "Ship the fix?",
      blocking: false,
      status: "pending",
      created_at: 1,
    } as const;
    const filed = await db.insert("session_decisions", {
      ...common,
      asked_user_ids: [asked],
      short_id: "sd-1",
      report_slug: "trialpage",
      options: [{ label: "Ship", page_slug: "otherpage" }],
    });
    await db.insert("session_decisions", {
      ...common,
      asked_user_ids: [asked],
      short_id: "sd-2",
      options: [{ label: "Ship" }],
    });
    return { owner, asked, stranger, filed };
  });
  const viewerClient = (viewer: "owner" | "asked" | "stranger" | null) =>
    viewer ? asUser(t, ids[viewer]) : t;
  return {
    filed: ids.filed,
    unlock: (
      viewer: "owner" | "asked" | "stranger",
      args: FunctionArgs<typeof api.artifacts.ownerUnlock>,
    ) => viewerClient(viewer).query(api.artifacts.ownerUnlock, args),
    info: (
      viewer: "owner" | "asked" | "stranger" | null,
      pages: FunctionArgs<typeof api.artifacts.embedInfo>["pages"],
    ) => viewerClient(viewer).query(api.artifacts.embedInfo, { pages }),
  };
}

describe("ownerUnlock", () => {
  test("the owner opens their gated page", async () => {
    const { unlock } = await setup();
    const got = await unlock("owner", { slug: "trialpage" });
    expect(got?.k).toBe(await kTokenFor("h1", "trialpage"));
    expect(got?.title).toBe("The fix");
  });

  test("a person the decision asks opens the pages it filed, its report and an option's page", async () => {
    const { unlock, filed } = await setup();
    expect(
      (await unlock("asked", { slug: "trialpage", decision: "sd-1" }))?.k,
    ).toBeTruthy();
    expect(
      (await unlock("asked", { slug: "otherpage", decision: filed }))?.k,
    ).toBeTruthy();
  });

  test("a decision opens only pages it filed, and only for its readers", async () => {
    const { unlock } = await setup();
    expect(
      await unlock("asked", { slug: "trialpage", decision: "sd-2" }),
    ).toBeNull();
    expect(
      await unlock("stranger", { slug: "trialpage", decision: "sd-1" }),
    ).toBeNull();
    expect(await unlock("asked", { slug: "trialpage" })).toBeNull();
  });
});

describe("embedInfo", () => {
  test("one row per page: open, gated with its tokens for the owner, missing", async () => {
    const { info } = await setup();
    const [open, gated, missing] = await info("owner", [
      { slug: "openpage" },
      { slug: "trialpage" },
      { slug: "nopage" },
    ]);
    expect(open).toEqual({
      slug: "openpage",
      gated: false,
      title: "Open",
      version: 4,
      kind: "html",
      thumb: false,
    });
    expect(gated).toMatchObject({
      slug: "trialpage",
      gated: true,
      title: "The fix",
      version: 2,
    });
    expect(gated.k).toBeTruthy();
    expect(missing).toEqual({ slug: "nopage", missing: true });
  });

  test("a gated page is locked, with nothing about it, for anyone without a way in", async () => {
    const { info } = await setup();
    for (const viewer of ["stranger", null] as const) {
      const [row] = await info(viewer, [{ slug: "trialpage" }]);
      expect(row).toEqual({
        slug: "trialpage",
        gated: true,
        locked: true,
        kind: "html",
      });
    }
  });

  test("the decision a page was filed on lets its readers through, as ownerUnlock does", async () => {
    const { info } = await setup();
    const [row] = await info("asked", [
      { slug: "trialpage", decision: "sd-1" },
    ]);
    expect(row.k).toBeTruthy();
    const [other] = await info("asked", [
      { slug: "trialpage", decision: "sd-2" },
    ]);
    expect(other.locked).toBe(true);
  });

  test("a page named twice comes back once", async () => {
    const { info } = await setup();
    expect(
      await info("owner", [{ slug: "openpage" }, { slug: "openpage" }]),
    ).toHaveLength(1);
  });
});
