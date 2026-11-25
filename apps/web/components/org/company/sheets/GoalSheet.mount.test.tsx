import { expectAbsent } from "../../../../test-helpers/domExpect";
import { api } from "@codecast/convex/convex/_generated/api";
import type { InitiativeRow } from "@codecast/goals/initiative";
import { afterEach, spyOn, test } from "bun:test";
import { getFunctionName } from "convex/server";
import assert from "node:assert/strict";
import { act } from "react";
import type { DispatchCallArgs } from "../../../../lib/dispatchBinding";
import { stampRoster } from "../../../../lib/activeTeam";
import { useInboxStore, type ProjectItem } from "../../../../store/inboxStore";
import { webBuilders } from "../../../../test-helpers/builders";
import { mountWeb } from "../../../../test-helpers/mountWeb";
import { pending } from "../../../../test-helpers/testConvex";
import { GoalSheet } from "./GoalSheet";

let restoreClock: (() => void) | undefined;
afterEach(() => {
  restoreClock?.();
  restoreClock = undefined;
});

async function setup() {
  const fx = await import("../../../initiatives/initiativeFixture");
  const { ORG_FIXTURE_WITH_HEAD } = await import("../../orgFixture");
  const DAY = 86_400_000;
  // The growth role leads "Agent org" (its scope holds it), and the project's folder is where Sam and Ashot work.
  const tree = {
    ...ORG_FIXTURE_WITH_HEAD,
    roles: ORG_FIXTURE_WITH_HEAD.roles.map((r) =>
      r._id === "fixture-role-growth"
        ? {
            ...r,
            scope: {
              ...r.scope,
              project_ids: [...r.scope.project_ids, "proj-org"],
            },
          }
        : r,
    ),
  };
  const collections = {
    initiatives: fx.FIXTURE_INITIATIVES.map((r) => ({ ...r })),
    initiativeUpdates: fx.FIXTURE_UPDATES.map((u) => ({ ...u })),
    projects: fx.FIXTURE_PROJECTS.map<ProjectItem>((p) =>
      p._id === "proj-org"
        ? {
            ...p,
            short_id: "pj-org",
            project_path: "~/src/codecast",
            goal: "Every area of the product has a lead that is an agent.",
            success_metrics: ["A person reads one page a week"],
            risks: ["Roles step on each other"],
          }
        : p._id === "proj-inbox"
          ? { ...p, short_id: "pj-inbox" }
          : { ...p },
    )
      // Worked by people and no role: its folder is where Ashot and Sam have sessions.
      .concat([
        {
          ...fx.FIXTURE_PROJECTS.find((p) => p._id === "proj-billing")!,
          _id: "proj-platform",
          short_id: "pj-platform",
          title: "Platform",
          project_path: "~/src/platform",
          risks: undefined,
        },
      ])
      // Led by the growth role, whose brief says nothing about it: its pinned state speaks. No short id, no deadline.
      .concat([
        {
          ...fx.FIXTURE_PROJECTS.find((p) => p._id === "proj-billing")!,
          _id: "proj-led",
          short_id: undefined,
          title: "Led",
          owner_role_id: "fixture-role-growth",
          target_date: undefined,
          risks: undefined,
        },
      ])
      // In another workspace the viewer belongs to.
      .concat([
        {
          ...fx.FIXTURE_PROJECTS.find((p) => p._id === "proj-billing")!,
          _id: "proj-union",
          short_id: "pj-union",
          title: "Union outreach",
          workspace: "team:other-team",
          team_id: "other-team",
        },
      ]),
    tasks: fx.FIXTURE_TASKS,
    plans: fx.FIXTURE_PLANS,
  };
  const measurements: Partial<InitiativeRow> = {
    metrics: [
      {
        key: "weekly_active_teams",
        name: "Weekly active teams",
        target: "1,000",
      },
    ],
    scoreboard: {
      weekly_active_teams: {
        value: "412",
        observed_at: fx.FIXTURE_NOW - 2 * DAY,
        source: "https://example.com/board",
      },
    },
  };

  const fixtures = webBuilders("GoalSheet.mount.test.tsx");
  const clock = spyOn(Date, "now").mockReturnValue(fx.FIXTURE_NOW);
  restoreClock = () => clock.mockRestore();
  let web: Awaited<ReturnType<typeof mountWeb>>;
  const mount = async (ref: string) => {
    if (web) {
      await web.rerender(
        <GoalSheet key={ref} sheet={{ kind: "initiative", ref }} />,
      );
      return;
    }
    web = await mountWeb(
      <GoalSheet key={ref} sheet={{ kind: "initiative", ref }} />,
      {
        path: "/org",
        dispatch: true,
        setup: (backend, store) => {
          const team = "f".repeat(32);
          const inTeam = { team_id: team, workspace: `team:${team}` };
          store.syncTable("currentUser", {
            _id: "fixture-user-me",
            name: "Ashot",
          });
          store.syncTable("clientState", { ui: { active_team_id: team } });
          useInboxStore.setState({ clientStateInitialized: true });
          store.syncTable("orgTree", {
            ...tree,
            workspace: { ...tree.workspace, id: team },
          });
          store.syncTable("teams", [
            { _id: team, name: "Fixture" },
            { _id: "other-team", name: "Union" },
          ]);
          store.syncTable(
            "teamMembers",
            stampRoster(
              [
                {
                  _id: "fixture-user-me",
                  name: "Ashot Petrosian",
                  github_username: "ashot",
                },
                {
                  _id: "fixture-user-sam",
                  name: "Samvit Jain",
                  github_username: "samvit",
                },
              ],
              team,
            ),
          );
          store.syncTable(
            "initiatives",
            collections.initiatives.map((row) => ({
              ...row,
              ...(row._id === "init-org" ? measurements : {}),
              ...inTeam,
            })),
          );
          store.syncTable(
            "initiativeUpdates",
            collections.initiativeUpdates.map((row) => ({ ...row, ...inTeam })),
          );
          store.syncTable(
            "projects",
            collections.projects.map((row) =>
              fixtures.project.build({
                ...row,
                ...(row.workspace === "team:fixture-team" ? inTeam : {}),
              }),
            ),
          );
          store.syncTable(
            "tasks",
            collections.tasks.map((row) =>
              fixtures.task.build({ ...row, ...inTeam }),
            ),
          );
          store.syncTable(
            "plans",
            collections.plans.map((row) =>
              fixtures.plan.build({ ...row, ...inTeam }),
            ),
          );
          backend.mutation(api.dispatch.dispatch, ({ action }) =>
            action === "createProject"
              ? new Promise(() => {})
              : Promise.resolve(null),
          );
          backend.set(api.org.scopeFeed, pending);
          backend.set(api.initiatives.webUpdates, pending);
          backend.set(api.plans.webGet, pending);
          backend.set(api.initiatives.webList, pending);
          backend.set(api.org.roles, pending);
        },
      },
    );
  };
  const calls = () =>
    web.backend.mutations.flatMap(({ args }) => {
      const { action, args: params } = args as DispatchCallArgs;
      switch (action) {
        case "createProject":
          return [
            `createProject:${params[0].title}:${params[1]?.kind}:${params[1]?.initiativeId}`,
          ];
        case "postInitiativeUpdate":
          return [`post:${params[0]}:${params[1].health}:${params[1].body}`];
        case "updateInitiative":
          return [`update:${params[0]}:${JSON.stringify(params[1])}`];
        default:
          return [];
      }
    });
  const q = <T extends Element = HTMLElement>(sel: string) =>
    document.querySelector<T>(sel);
  const qa = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
  const click = async (el: Element | null | undefined) => {
    assert.ok(el, "missing element");
    await act(async () => {
      (el as HTMLElement).click();
    });
  };
  const type = async (el: Element | null, value: string) => {
    assert.ok(el, "missing field");
    const proto =
      el instanceof web.dom.window.HTMLTextAreaElement
        ? web.dom.window.HTMLTextAreaElement.prototype
        : web.dom.window.HTMLInputElement.prototype;
    await act(async () => {
      Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
      el.dispatchEvent(new web.dom.window.Event("input", { bubbles: true }));
    });
  };
  /** The sheet's sections and folds, in the order they read. */
  const order = () =>
    qa(
      "[data-sheet-body] [data-initiative-section], [data-sheet-body] [data-sheet-section], [data-sheet-body] [data-sheet-fold]",
    )
      .filter((el) => !el.parentElement?.closest("[data-sheet-fold]"))
      .map(
        (el) =>
          el.getAttribute("data-initiative-section") ??
          el.getAttribute("data-sheet-section") ??
          `fold:${el.getAttribute("data-sheet-fold")}`,
      );
  const queryRequests = () => web.backend.queryRequests;
  const fire = (form: HTMLFormElement) =>
    form.dispatchEvent(
      new window.Event("submit", { bubbles: true, cancelable: true }),
    );
  const menu = async () => {
    await act(async () =>
      q<HTMLButtonElement>("[data-sheet-menu]")!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    const items = qa('[role="menuitem"]').map((button) => button.textContent);
    await act(async () =>
      document
        .querySelector('[role="menu"]')
        ?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        ),
    );
    return items;
  };
  return { mount, q, qa, click, type, fire, order, queryRequests, menu, calls };
}

test("a goal sheet reads its sections, work and open plans in order", async () => {
  const { mount, q, qa, order } = await setup();
  await mount("in-1");
  assert.equal(q("[data-sheet]")!.getAttribute("data-sheet"), "initiative");
  assert.deepEqual(order(), [
    "why",
    "metrics",
    "Now",
    "carried",
    "updates",
    "fold:The record",
    "fold:Activity",
  ]);
  // The head: owner, health, the number against its target, the date. A goal's progress is its number: no task bar.
  const facts = q("[data-sheet-facts]")!;
  assert.match(facts.textContent!, /412/);
  expectAbsent(q("[data-initiative-progress]"), "no task bar on a goal");
  // Why reads the goal's own words.
  assert.match(
    q("[data-goal-why]")!.textContent!,
    /routing work that an agent could route/,
  );
  // Now: the sessions at work under the projects that carry it.
  assert.match(q("[data-now-sessions]")!.textContent!, /at work/);
  // Carried by: its projects, each with what it says against itself, then the goal under it.
  const carried = q("[data-initiative-section='carried']")!;
  assert.deepEqual(
    qa("[data-initiative-section='carried'] [data-line]").map(
      (l) =>
        `${l.getAttribute("data-line")}:${l.getAttribute("data-line-ref") ?? l.getAttribute("data-line-id")}`,
    ),
    ["project:pj-org", "project:pj-inbox", "goal:in-2"],
  );
  // The trouble word stands in the state cell, so the name keeps the whole title column; a quiet active project says nothing there.
  assert.match(
    carried.querySelector(
      "[data-initiative-project='proj-inbox'] [data-line-state] [data-initiative-project-trouble]",
    )!.textContent!,
    /past its target/,
  );
  expectAbsent(
    carried.querySelector("[data-initiative-project='proj-inbox'] .ol-sub"),
  );
  expectAbsent(
    carried.querySelector(
      "[data-initiative-project] [data-project-status='active']",
    ),
    "no line says active",
  );
  // Under each project, its open plans (ct-95899): the done one is not listed.
  assert.deepEqual(
    Array.from(
      carried.querySelectorAll(
        "[data-initiative-project-plans='proj-org'] [data-initiative-plan]",
      ),
    ).map((l) => l.getAttribute("data-initiative-plan")),
    ["pl-715"],
  );
  expectAbsent(
    carried.querySelector("[data-initiative-project-plans='proj-inbox']"),
    "a project with no open plan lists none",
  );
  assert.ok(
    carried.querySelector("[data-initiative-projects-edit]"),
    "+ Project",
  );
});

test("a new project appears under its goal before the server responds", async () => {
  const { mount, q, qa, click, type, fire, calls } = await setup();
  await mount("in-1");
  await click(q("[data-initiative-projects-edit]"));
  await type(q("[data-initiative-new-project]"), "Launch kit");
  await act(async () => {
    fire(q("[data-initiative-new-project]")!.closest("form")!);
  });
  assert.equal(
    calls().at(-1),
    "createProject:Launch kit:attachToInitiative:init-org",
  );
  await click(q("[data-initiative-projects-edit]"));
  assert.equal(
    q<HTMLInputElement>("[data-initiative-new-project]")!.value,
    "",
    "the field clears",
  );
  await click(q("[data-initiative-projects-edit]"));
  const stub = qa(
    "[data-initiative-section='carried'] [data-initiative-project]",
  ).find((l) =>
    l.getAttribute("data-initiative-project")!.startsWith("projstub-"),
  );
  assert.ok(
    stub && /Launch kit/.test(stub.textContent!),
    "the new project is carried by the goal in the same tick",
  );
});

test("the latest update reads first and the older updates and record open on demand", async () => {
  const { mount, q, qa, click } = await setup();
  await mount("in-1");
  assert.deepEqual(
    qa("[data-initiative-update]").map((u) =>
      u.getAttribute("data-initiative-update"),
    ),
    ["upd-2"],
  );
  await click(q("[data-initiative-updates-older]"));
  assert.deepEqual(
    qa("[data-initiative-update]").map((u) =>
      u.getAttribute("data-initiative-update"),
    ),
    ["upd-2", "upd-1"],
  );
  // The record, folded, says what it holds.
  assert.equal(
    q("[data-sheet-fold='The record'] button")!
      .textContent!.replace("▸", "")
      .trim(),
    "The recorddone when · 5 milestones · 2 questions · 2 decisions · 2 sources",
  );
  expectAbsent(q("[data-initiative-record]"), "folded until opened");
  await click(q("[data-sheet-fold='The record'] button"));
  assert.ok(q("[data-initiative-record='in-1']"));
  expectAbsent(
    q("[data-initiative-section='why'] ~ [data-initiative-section='why']"),
  );
});

test("activity requests updates for the goal and its subgoal", async () => {
  const { mount, q, click, queryRequests } = await setup();
  await mount("in-1");
  await click(q("[data-sheet-fold='Activity'] button"));
  assert.ok(
    queryRequests().some(({ name, args }) => {
      if (name !== getFunctionName(api.org.scopeFeed)) return false;
      const scope = (args as { scope?: { initiative_ids?: string[] } }).scope;
      return (
        scope?.initiative_ids?.slice().sort().join(",") ===
        "init-org,init-org-sub"
      );
    }),
  );
});

test("a posted update changes the latest update and the sheet health immediately", async () => {
  const { mount, q, qa, click, type, fire, calls } = await setup();
  await mount("in-1");
  await click(q("[data-initiative-update-open]"));
  await type(
    q("[data-initiative-update-form] textarea"),
    "The scope view shipped.",
  );
  await click(q("[data-initiative-update-health-pick='on_track']"));
  await act(async () => {
    fire(q<HTMLFormElement>("[data-initiative-update-form]")!);
  });
  assert.equal(
    calls().at(-1),
    "post:init-org:on_track:The scope view shipped.",
  );
  expectAbsent(q("[data-initiative-update-form]"), "the form closes");
  assert.equal(
    qa("[data-initiative-update]")[0].getAttribute(
      "data-initiative-update-health",
    ),
    "on_track",
    "the new update reads first",
  );
  assert.match(
    q("[data-sheet-facts]")!.textContent!,
    /On track/i,
    "and the head says what it said",
  );
});

test("a fresh goal offers its editors in one line", async () => {
  const { mount, q, qa, click, type, order, menu, calls } = await setup();
  await mount("in-4");
  assert.deepEqual(
    order(),
    [],
    "nothing else: no empty Why, no number, no Now, no Carried by, no updates, no record",
  );
  assert.equal(
    q("[data-goal-still]")!.textContent,
    "Still to write: why it matters · a number · what done looks like",
  );
  assert.deepEqual(
    qa("[data-goal-sheet] .italic").map((e) => e.outerHTML),
    [],
    "no column of italics under the head",
  );
  assert.doesNotMatch(
    q("[data-sheet-body]")!.textContent!,
    /Nobody|No milestones|No project carries|No update yet|Nothing recorded/,
  );
  assert.deepEqual(await menu(), [
    "Post an update",
    "Add a number",
    "Add a project",
    "Cancel this goal",
  ]);
  // "why it matters" opens Why on its editor; cancelled unwritten, Why goes and the phrase is back.
  await click(q("[data-goal-still-item='why']"));
  assert.ok(
    q("[data-goal-why] [data-initiative-field='why']"),
    "Why opens on its editor",
  );
  expectAbsent(q("[data-goal-still-item='why']"));
  await click(
    [...q("[data-goal-why]")!.querySelectorAll("button")].find(
      (b) => b.textContent === "Cancel",
    ),
  );
  expectAbsent(q("[data-goal-why]"));
  assert.ok(q("[data-goal-still-item='why']"));
  // Written, the phrase goes for good.
  await click(q("[data-goal-still-item='why']"));
  await type(
    q("[data-initiative-field='why']"),
    "Half our users open codecast on a phone.",
  );
  await click(q("[data-goal-why] [data-initiative-form-submit]"));
  assert.equal(
    calls().at(-1),
    `update:init-orphan:${JSON.stringify({ why: "Half our users open codecast on a phone." })}`,
  );
  assert.match(q("[data-goal-why]")!.textContent!, /on a phone/);
  assert.equal(
    q("[data-goal-still]")!.textContent,
    "Still to write: a number · what done looks like",
  );
  // "a number" opens Measured by on its form, as the menu does.
  await click(q("[data-goal-still-item='number']"));
  assert.ok(
    q("[data-initiative-metrics-form]"),
    "Measured by opens on its form",
  );
  assert.equal(
    q("[data-goal-still]")!.textContent,
    "Still to write: what done looks like",
  );
  // "what done looks like" opens the record on done when, and the line is gone.
  await click(q("[data-goal-still-item='done_when']"));
  expectAbsent(q("[data-goal-still]"));
  assert.ok(
    q(
      "[data-sheet-fold='The record'][data-open] [data-initiative-field='done_when']",
    ),
    "the record opens with done when ready to write",
  );
});

test("a goal with an unset number lists it and a complete goal has no starter line", async () => {
  const { mount, q } = await setup();
  await mount("in-2");
  assert.equal(
    q("[data-goal-still]")!.textContent,
    "Still to write: why it matters · a number · what done looks like",
  );
  expectAbsent(q("[data-goal-why]"));
  // The head's health and the latest update's read in the same case.
  await mount("in-1");
  expectAbsent(
    q("[data-goal-still]"),
    "a goal with everything written has no starter line",
  );
  assert.match(
    q("[data-initiative-update] [data-initiative-health]")!.textContent!,
    /^[a-z]/,
  );
});
