// Regression tests for scanConversationsForPath — the take()-based replacement
// for the paginate()-based path scan. The old version ran one paginated query
// per source (git_root, then project_path) inside a single mutation execution,
// which Convex rejects ("only a single paginated query in each function"), so
// delete-by-path threw for any conversation that wasn't matched by the very
// first git_root page. Discovered by `cast doctor`'s cleanup verification: its
// scratch project has no git repo, so the git_root range was empty and the
// second paginate call blew up — leaving the self-test conversation behind.

import { describe, expect, test } from "bun:test";
import { scanConversationsForPath } from "./users";

import { serverTest, type ServerTest } from "../test-helpers/database.testkit";
import { fixtureRows, type NewRow } from "../test-helpers/rows.testkit";
import type { Doc, Id } from "./_generated/dataModel";

async function seed(
  paths: Partial<NewRow<"conversations">>[],
  options: { otherUser?: boolean } = {},
) {
  const t = serverTest();
  const { user, ids } = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "conversation paths");
    const user = await rows.user();
    const owner = options.otherUser ? await rows.user() : user;
    const ids = [];
    for (const fields of paths)
      ids.push(await rows.conversation(owner, fields));
    return { user, ids };
  });
  return { t, user, ids };
}

async function scan(
  t: ServerTest,
  user: Id<"users">,
  prefix: string,
  visit?: (conversation: Doc<"conversations">) => boolean,
) {
  return t.run(async (ctx) => {
    const seen: Id<"conversations">[] = [];
    const { truncated } = await scanConversationsForPath(
      ctx,
      user,
      prefix,
      (conversation: Doc<"conversations">) => {
        seen.push(conversation._id);
        return visit ? visit(conversation) : true;
      },
    );
    return { seen, truncated };
  });
}

describe("scanConversationsForPath", () => {
  test("finds a project_path-only conversation (the case the paginate version threw on)", async () => {
    const path = "/home/u/.codecast/doctor/e2e-x";
    const {
      t,
      user,
      ids: [target],
    } = await seed([{ project_path: path }, { project_path: "/home/u/other" }]);
    expect((await scan(t, user, path)).seen).toEqual([target]);
  });

  test("git_root rows are matched via git_root and not double-visited via project_path", async () => {
    const {
      t,
      user,
      ids: [repo],
    } = await seed([
      { git_root: "/home/u/proj", project_path: "/home/u/proj/sub" },
    ]);
    expect((await scan(t, user, "/home/u/proj")).seen).toEqual([repo]);
  });

  test("sibling-prefix paths are filtered out", async () => {
    const {
      t,
      user,
      ids: [, target],
    } = await seed([
      { project_path: "/home/u/proj-other" },
      { project_path: "/home/u/proj" },
    ]);
    expect((await scan(t, user, "/home/u/proj")).seen).toEqual([target]);
  });

  test("visit returning false stops the scan", async () => {
    const { t, user } = await seed([
      { project_path: "/p/x/a" },
      { project_path: "/p/x/b" },
    ]);
    expect((await scan(t, user, "/p/x", () => false)).seen).toHaveLength(1);
  });

  test("a match beyond the first batch is still found (batch doubling, no skipped rows)", async () => {
    const { t, user, ids } = await seed([
      ...Array.from({ length: 200 }, (_, i) => ({
        project_path: `/p/proj/decoy${String(i).padStart(3, "0")}`,
      })),
      { project_path: "/p/proj/a-real" },
    ]);
    const { seen } = await scan(t, user, "/p/proj");
    expect(seen).toHaveLength(201);
    expect(seen).toContain(ids[200]);
  });

  test("other users' conversations are invisible", async () => {
    const { t, user } = await seed([{ project_path: "/p/x/a" }], {
      otherUser: true,
    });
    expect((await scan(t, user, "/p/x")).seen).toEqual([]);
  });
});

describe("scanConversationsForPath reads newest first and reports the cap", () => {
  test("a repository past the cap yields its newest sessions, flagged truncated", async () => {
    const path = "/home/u/big";
    const { t, user, ids } = await seed(
      Array.from({ length: 1100 }, () => ({ git_root: path })),
    );
    const { truncated, seen } = await scan(t, user, path);
    expect(truncated).toBe(true);
    expect(seen).toHaveLength(1024);
    expect(seen[0]).toBe(ids[1099]);
    expect(seen).toEqual(ids.slice(76).reverse());
  });

  test("a small repository is not flagged", async () => {
    const path = "/home/u/small";
    const {
      t,
      user,
      ids: [older, newer],
    } = await seed([{ git_root: path }, { git_root: path }]);
    const { truncated, seen } = await scan(t, user, path);
    expect(truncated).toBe(false);
    expect(seen).toEqual([newer, older]);
  });
});
