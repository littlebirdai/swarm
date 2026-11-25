// goals.brief (the-line-end-to-end.md LE5): the active initiatives of the
// caller's workspace with their metrics, and the charter of every live project
// that has one or that an active initiative carries. Other workspaces, closed
// initiatives and charterless side projects stay out.
import { describe, expect, test } from "bun:test";
import { serverTest } from "../test-helpers/database.testkit";
import { fixtureRows, type NewRow } from "../test-helpers/rows.testkit";
import { api } from "./_generated/api";

const TOKEN = "goals-token";

async function setup() {
  const t = serverTest();
  const workspace = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "goals brief");
    const owner = await rows.user();
    const other = await rows.user();
    const workspace = `user:${owner}`;
    await rows.token(owner, TOKEN);
    const role = await rows.role(owner, { handle: "growth" });

    const addProject = (
      fields: Pick<NewRow<"projects">, "short_id" | "title"> &
        Partial<NewRow<"projects">>,
    ) =>
      db.insert("projects", {
        user_id: owner,
        workspace,
        status: "active",
        created_at: 1,
        updated_at: 1,
        ...fields,
      });
    const onboarding = await addProject({
      short_id: "pj-a",
      title: "Onboarding",
      goal: "Day one agent run",
      priority: "p1",
      owner_role_id: role,
    });
    const carried = await addProject({
      short_id: "pj-b",
      title: "Carried",
      status: "planning",
    });
    await addProject({ short_id: "pj-c", title: "Side" });
    await addProject({
      short_id: "pj-d",
      title: "Shipped",
      status: "done",
      goal: "Old",
    });
    await addProject({
      short_id: "pj-x",
      title: "Theirs",
      goal: "Hidden",
      user_id: other,
      workspace: `user:${other}`,
    });

    const addInitiative = (
      fields: Pick<NewRow<"initiatives">, "short_id" | "title"> &
        Partial<NewRow<"initiatives">>,
    ) =>
      db.insert("initiatives", {
        user_id: owner,
        workspace,
        status: "active",
        health: "none",
        project_ids: [],
        created_at: 1,
        updated_at: 1,
        ...fields,
      });
    await addInitiative({
      short_id: "in-1",
      title: "Retention",
      health: "at_risk",
      priority: "p0",
      owner: { kind: "role", role_id: role },
      project_ids: [onboarding, carried],
      metrics: [{ key: "w4", name: "Week 4", target: "40%" }],
      scoreboard: { w4: { value: "31%", observed_at: 1, source: "posthog" } },
    });
    await addInitiative({
      short_id: "in-2",
      title: "Done",
      status: "completed",
    });
    await addInitiative({
      short_id: "in-3",
      title: "Theirs",
      user_id: other,
      workspace: `user:${other}`,
    });
    return workspace;
  });

  return {
    workspace,
    brief: (project?: string) =>
      t.query(api.goals.brief, {
        api_token: TOKEN,
        workspace: "personal",
        project,
      }),
  };
}

describe("goals.brief", () => {
  test("the caller's workspace: active initiatives and live charters", async () => {
    const { brief, workspace } = await setup();
    const out = await brief();
    expect(out.workspace).toBe(workspace);
    expect(out.initiatives[0].target_date).toBeUndefined();
    expect(out.initiatives[0].description).toBeUndefined();
    expect(out.initiatives).toEqual([
      {
        short_id: "in-1",
        title: "Retention",
        priority: "p0",
        owner: "@growth",
        health: "at_risk",
        metrics: [{ key: "w4", name: "Week 4", target: "40%" }],
        scoreboard: { w4: { value: "31%", observed_at: 1, source: "posthog" } },
        project_short_ids: ["pj-a", "pj-b"],
        // A metric with no noise model can say nothing about what a read detects.
        read_at: [{ ref: "in-1:w4", name: "Week 4", detects: null }],
      },
    ]);
    expect(out.projects.map((p) => p.short_id).sort()).toEqual([
      "pj-a",
      "pj-b",
    ]);
    expect(out.projects.find((p) => p.short_id === "pj-a")).toMatchObject({
      goal: "Day one agent run",
      priority: "p1",
      owner_role: "@growth",
    });
  });

  test("one project (LP1): its charter and the initiatives that carry it, nothing else", async () => {
    const { brief } = await setup();
    const out = await brief("Carried");
    expect(out.project_title).toBe("Carried");
    expect(out.projects.map((p) => p.short_id)).toEqual(["pj-b"]);
    expect(out.initiatives.map((i) => i.short_id)).toEqual(["in-1"]);
    const side = await brief("pj-c");
    expect(side.projects.map((p) => p.short_id)).toEqual(["pj-c"]);
    expect(side.initiatives).toEqual([]);
    await expect(brief("Theirs")).rejects.toThrow(/No project matching/);
  });
});
