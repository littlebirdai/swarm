// `cast task ls -q`: a search reads bounded slices of one workspace (the title
// search index, a short id, the most recently touched rows), never the whole
// open set, which ran out of the server's 64 MB on a large team.
import { describe, expect, test } from "bun:test";
import type { FunctionArgs } from "convex/server";
import { serverTest } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import { api } from "./_generated/api";

const TOKEN = "task-search-token";

describe("task search", () => {
  test("finds by title, short id and description, open work only by default", async () => {
    const t = serverTest({ documentsRead: 360 });
    const team = await t.run(async ({ db }) => {
      const rows = fixtureRows(db, "team task search");
      const team = await rows.team();
      const other = await rows.team();
      const owner = await rows.user({ active_team_id: team, team_id: team });
      await rows.membership(owner, team, { role: "admin" });
      await rows.token(owner, TOKEN);
      const workspace = `team:${team}`;
      const add = (n: number, fields: Parameters<typeof rows.task>[1] = {}) =>
        rows.task(owner, {
          short_id: `ct-${n}`,
          team_id: team,
          workspace,
          updated_at: n,
          ...fields,
        });
      await add(1, { title: "Deploy the convex backend" });
      await add(2, {
        title: "Unrelated",
        description: "mentions deploy in passing",
        updated_at: 1000,
      });
      await add(3, {
        title: "Deploy finished long ago",
        status: "done",
        updated_at: 1001,
      });
      await add(4, {
        title: "Another team's deploy",
        team_id: other,
        workspace: `team:${other}`,
      });
      await add(5, { title: "Nothing here" });
      for (let n = 6; n < 700; n++)
        await add(n, { title: "Archive unrelated work" });
      return team;
    });
    const list = (
      args: Pick<FunctionArgs<typeof api.tasks.list>, "query" | "include_done">,
    ) =>
      t.query(api.tasks.list, {
        api_token: TOKEN,
        workspace: "team",
        team_id: team,
        ...args,
      });

    const open = await list({ query: "deploy" });
    expect(open.map((r) => r.short_id).sort()).toEqual(["ct-1", "ct-2"]);

    const all = await list({ query: "deploy", include_done: true });
    expect(all.map((r) => r.short_id).sort()).toEqual(["ct-1", "ct-2", "ct-3"]);

    const byId = await list({ query: "ct-5" });
    expect(byId.map((r) => r.short_id)).toEqual(["ct-5"]);
  });
});
