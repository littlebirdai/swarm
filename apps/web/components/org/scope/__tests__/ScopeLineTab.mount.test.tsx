import { expect, test } from "bun:test";
import { act } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import { webBuilders } from "../../../../test-helpers/builders";
import {
  expectAbsent,
  expectPresent,
} from "../../../../test-helpers/domExpect";
import { mountWeb } from "../../../../test-helpers/mountWeb";
import { pending } from "../../../../test-helpers/testConvex";
import { ScopeLineTab } from "../ScopeLineTab";

const builders = webBuilders("scope line");
const team = "t1";
const workspace = `team:${team}`;
const me = builders.teamMember.build({ name: "Me" });
const sam = builders.teamMember.build({ name: "Sam Reviewer" });
const bystander = builders.teamMember.build({ name: "Pat Owner" });
const project = builders.project.build({ workspace });
const outside = builders.project.build({ workspace });
const hand = builders.session.build({
  agent_status: "working",
  is_connected: true,
  is_idle: false,
  updated_at: Date.now(),
});
const a = builders.task.build({
  short_id: "ct-1",
  title: "Rotate the prod key",
  status: "in_progress",
  workspace,
  project_id: project._id,
  assignee: sam._id,
  files_changed: ["a.ts", "b.ts"],
});
const b = builders.task.build({
  short_id: "ct-2",
  title: "Write the release note",
  status: "in_review",
  workspace,
  project_id: project._id,
});
const outOfScope = builders.task.build({
  short_id: "ct-3",
  title: "Out of scope",
  status: "open",
  workspace,
  project_id: outside._id,
});

function mount(projectId: string) {
  return mountWeb(
    <ScopeLineTab
      ids={{ projectIds: [projectId], planIds: [], whole: false }}
    />,
    {
      path: "/org/or-1?tab=line",
      setup(backend, store) {
        store.syncTable("currentUser", me);
        store.syncTable("teams", [{ _id: team, name: "Acme" }]);
        store.syncTable("clientState", { ui: { active_team_id: team } });
        store.syncTable(
          "teamMembers",
          [me, sam, bystander].map((person) => ({
            ...person,
            roster_team: team,
          })),
        );
        store.syncTable("sessions", [hand]);
        store.syncTable("tasks", [a, b, outOfScope]);
        store.syncTable("workflowRuns", [
          {
            _id: "r1",
            task_id: a._id,
            status: "running",
            workspace,
            current_node_id: "implement",
            current_node_label: "Implement",
            primary_conversation_id: hand._id,
            created_at: 1,
            updated_at: 2,
          },
        ]);
        store.syncTable("sessionDecisions", [
          {
            _id: "d1",
            short_id: "sd-9",
            status: "pending",
            blocking: true,
            task_id: b._id,
            station: "in_review",
            question: "Ship it?",
            options: [],
            conversation_id: hand._id,
            session_id: hand._id,
            created_at: 1,
          },
        ]);
        backend.set(api.workflow_runs.listRuns, pending);
        backend.set(api.artifacts.listForWeb, pending);
        backend.set(api.org.roles, pending);
      },
    },
  );
}

test("two tasks at different stations paint in their columns with node, hand state, hold and evidence", async () => {
  const web = await mount(project._id);
  const qa = (sel: string) => [
    ...web.container.querySelectorAll<HTMLElement>(sel),
  ];

  expect(
    qa("[data-line-column]").map((c) => c.getAttribute("data-line-column")),
  ).toEqual(["backlog", "open", "in_progress", "in_review", "done", "dropped"]);
  expect(
    qa("[data-line-card]").map((c) => c.getAttribute("data-line-card")),
  ).toEqual(["ct-1", "ct-2"]);
  expect(
    qa('[data-line-column="in_progress"] [data-line-card]').map((c) =>
      c.getAttribute("data-line-card"),
    ),
  ).toEqual(["ct-1"]);
  expect(
    qa('[data-line-column="in_review"] [data-line-card]').map((c) =>
      c.getAttribute("data-line-card"),
    ),
  ).toEqual(["ct-2"]);
  expect(qa('[data-line-column="open"] [data-line-card]')).toEqual([]);
  expect(
    web.container.querySelector('[data-line-column="open"]')!.textContent,
  ).toMatch(/Nothing here\./);

  const a = web.container.querySelector('[data-line-card="ct-1"]')!;
  expect(a.querySelector("[data-line-node]")!.textContent).toMatch(/Implement/);
  expect(a.querySelector("[data-line-node]")!.textContent).toMatch(/working/);
  expectPresent(a.querySelector('[title="Sam Reviewer"]'));
  expectAbsent(a.querySelector('[title="Pat Owner"]'));
  expect(a.textContent).toMatch(/2 files/);
  expect(a.textContent).not.toMatch(/page/);
  expect(a.querySelector("[data-line-held]")).toBeNull();
  expect(a.querySelector("a")!.getAttribute("href")).toBe("/tasks/ct-1");

  const b = web.container.querySelector('[data-line-card="ct-2"]')!;
  const held = b.querySelector("[data-line-held]")!;
  expect(held.textContent).toMatch(/held · sd-9/);
  expect(held.getAttribute("href")).toBe("/decisions/sd-9");
  expectAbsent(b.querySelector("[data-line-node]"));
  const taskLink = a.querySelector<HTMLAnchorElement>('a[href="/tasks/ct-1"]');
  expectPresent(taskLink);
  await act(async () => taskLink.click());
  expect(web.navigationLog.at(-1)).toEqual({
    action: "push",
    path: "/tasks/ct-1",
  });
  await web.close();
});

test("an empty scope says so instead of drawing columns", async () => {
  const web = await mount("none");
  expect(web.container.textContent).toMatch(/No tasks here yet/);
  expectAbsent(web.container.querySelector("[data-line-column]"));
  await web.close();
});
