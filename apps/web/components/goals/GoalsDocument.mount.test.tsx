import { api } from "@codecast/convex/convex/_generated/api";
import { getUndoHistory, resetUndoHistory } from "@platform/engine";
import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import { act } from "react";
import type { DispatchCallArgs } from "../../lib/dispatchBinding";
import { webBuilders } from "../../test-helpers/builders";
import { mountWeb } from "../../test-helpers/mountWeb";
import { stampRoster } from "../../lib/activeTeam";
import { useInboxStore } from "../../store/inboxStore";
import { GoalsDocument } from "./GoalsDocument";

afterEach(resetUndoHistory);

async function setup() {
  const fx = await import("../company/companyFixture");
  const { UNION_GOALS_UPDATES } = await import("../org/goalsFixture");
  const team = "u".repeat(32);
  const tree = {
    ...fx.COMPANY_FIXTURE_TREE,
    workspace: { ...fx.COMPANY_FIXTURE_TREE.workspace, id: team },
  };
  const NOW = fx.COMPANY_FIXTURE_NOW;
  const series = {
    _id: "w1",
    short_id: "mw-7",
    workspace: `team:${tree.workspace.id}`,
    name: "Brokers sending deals",
    unit: "brokers",
    query_kind: "reader",
    query: "metrics.read",
    direction: "below",
    interval_ms: 3600_000,
    status: "active",
    state: "ok",
    points: [
      { at: NOW - 6 * 86_400_000, value: 9 },
      { at: NOW - 3600_000, value: 14 },
    ],
    last_value: 14,
    last_at: NOW - 3600_000,
    source_name: "union",
    source_short_id: "src-13",
    source_id: "s",
    updated_at: NOW,
  };
  // in-2's first number reads live from mw-7.
  const initiatives = fx.COMPANY_FIXTURE_INITIATIVES.map((g) => ({
    ...g,
    ...(g.short_id === "in-2" && g.metrics?.length
      ? {
          metrics: g.metrics.map((m, i) =>
            i === 0 ? { ...m, series: "mw-7" } : m,
          ),
        }
      : {}),
  }));
  const fixtures = webBuilders("GoalsDocument.mount.test.tsx");
  const { backend, store, dom } = await mountWeb(<GoalsDocument />, {
    path: "/goals",
    dispatch: true,
    setup: (backend, state) => {
      state.syncTable("currentUser", {
        _id: "fixture-user-me",
        name: "Ashot Petrosian",
      });
      state.syncTable("clientState", { ui: { active_team_id: team } });
      useInboxStore.setState({ clientStateInitialized: true });
      state.syncTable("teams", [{ _id: team, name: "Union" }]);
      state.syncTable(
        "teamMembers",
        stampRoster(fx.COMPANY_FIXTURE_ROSTER, team),
      );
      state.syncTable("orgTree", tree);
      state.syncTable(
        "projects",
        fx.COMPANY_FIXTURE_PROJECTS.map((row) =>
          fixtures.project.build({ ...row, workspace: `team:${team}` }),
        ),
      );
      state.syncTable(
        "tasks",
        fx.COMPANY_FIXTURE_TASKS.map((row) =>
          fixtures.task.build({
            status: row.status ?? undefined,
            project_id:
              typeof row.project_id === "string" ? row.project_id : undefined,
            source: row.source ?? undefined,
            workspace: `team:${team}`,
          }),
        ),
      );
      state.syncTable(
        "initiatives",
        initiatives.map((row) => ({
          ...row,
          team_id: team,
          workspace: `team:${team}`,
        })),
      );
      state.syncTable(
        "initiativeUpdates",
        UNION_GOALS_UPDATES.map((row) => ({
          ...row,
          team_id: team,
          workspace: `team:${team}`,
        })),
      );
      state.syncTable("opsWatches", [series]);
      backend.set(api.org.roles, undefined);
      backend.set(api.projects.webList, undefined);
      backend.set(api.orgProposals.list, undefined);
      backend.set(api.initiatives.webList, undefined);
      backend.set(api.initiatives.webUpdates, undefined);
    },
  });
  const calls = () =>
    backend.mutations.flatMap(({ args }) => {
      const { action, args: params } = args as DispatchCallArgs;
      switch (action) {
        case "updateProject":
          return [`project:${params[0]}:${JSON.stringify(params[1])}`];
        case "createInitiative":
          return [`create:${JSON.stringify(params[0])}`];
        case "updateInitiative":
          return [`update:${params[0]}:${JSON.stringify(params[1])}`];
        case "addInitiativeProject":
          return [`add:${params[0]}:${params[1]}`];
        case "removeInitiativeProject":
          return [`remove:${params[0]}:${params[1]}`];
        default:
          return [];
      }
    });

  const q = <T extends Element = HTMLElement>(sel: string) =>
    document.querySelector<T>(sel);
  const qa = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
  const W = dom.window;
  const key = async (
    el: Element | null,
    k: string,
    opts: Record<string, boolean> = {},
  ) => {
    assert.ok(el, `no element for ${k}`);
    await act(async () => {
      el!.dispatchEvent(
        new W.KeyboardEvent("keydown", {
          key: k,
          bubbles: true,
          cancelable: true,
          ...opts,
        }),
      );
    });
  };
  const type = async (el: HTMLTextAreaElement, text: string) => {
    await act(async () => {
      el.focus();
      el.value = text;
      el.dispatchEvent(new W.Event("input", { bubbles: true }));
    });
  };
  const blur = async (el: HTMLElement) => {
    await act(async () => {
      el.blur();
    });
  };
  const top = () =>
    qa("[data-goals-list='top'] > div > [data-goal-section]").map((s) =>
      s.getAttribute("data-goal-section"),
    );
  const title = (ref: string) =>
    q<HTMLTextAreaElement>(`[data-goal-title='${ref}']`)!;
  const since = (n: number) => calls().slice(n);

  return { store, q, qa, W, key, type, blur, top, title, since, calls };
}

test("goals read in order with their subgoals, measures, updates and projects", async () => {
  const { q, qa, top } = await setup();
  assert.deepEqual(
    top(),
    ["in-2", "in-4", "in-1"],
    "the top goals in list order, each a section",
  );
  assert.ok(
    q("[data-goal-section='in-2'] [data-goal-section='in-5']"),
    "a goal under another reads inside its section",
  );
  assert.match(
    q("[data-goal-section='in-2'] [data-goal-why]")!.textContent!,
    /Brokers place the deals/,
    "why it matters, in full",
  );
  assert.ok(
    q("[data-goal-section='in-2'] [data-goal-numbers] [data-metric='brokers']"),
    "its numbers against their targets",
  );
  assert.ok(
    q("[data-goal-section='in-2'] [data-initiative-update='union-upd-1']"),
    "the latest update in full",
  );
  assert.deepEqual(
    qa("[data-goal-projects='in-2'] > div > [data-goal-project]").map(
      (p) => p.dataset.goalProject,
    ),
    ["union-proj-network", "union-proj-outreach"],
    "every project it carries, in the owner's order",
  );
});

test("a goal title saves on blur and returns to its saved value on Escape", async () => {
  const { key, type, blur, title, since, calls } = await setup();
  let n = calls().length;
  const t2 = title("in-2");
  await type(t2, "Win the private broker network");
  await blur(t2);
  assert.deepEqual(since(n), [
    `update:union-in-2:${JSON.stringify({ title: "Win the private broker network" })}`,
  ]);
  await type(t2, "scrap this");
  await key(t2, "Escape");
  assert.equal(
    t2.value,
    "Win the private broker network",
    "Escape puts the title back",
  );
});

test("Enter creates a goal in place and starts the next draft", async () => {
  const { q, key, type, top, title, since, calls } = await setup();
  const n = calls().length;
  await key(title("in-4"), "Enter");
  const draft = q<HTMLTextAreaElement>("[data-goal-draft] textarea")!;
  assert.ok(draft, "Enter opens a new goal's heading");
  assert.equal(
    draft.closest("[data-goals-list]")!.getAttribute("data-goals-list"),
    "top",
  );
  await type(draft, "Close the first paid deal");
  await key(draft, "Enter");
  const created = since(n).find((c) => c.startsWith("create:"));

  assert.ok(created, "the draft is created");
  const input = JSON.parse(created!.slice(7));
  assert.equal(input.title, "Close the first paid deal");
  assert.equal(input.workspace, "team");
  assert.deepEqual(input.owner, { kind: "user", user_id: "fixture-user-me" });
  assert.equal(
    top().indexOf(input.client_key),
    top().indexOf("in-4") + 1,
    "it lands right after the goal it followed",
  );
  assert.ok(
    q("[data-goal-draft] textarea"),
    "and the next one starts after it",
  );
  await key(q("[data-goal-draft] textarea"), "Escape");
  assert.equal(
    q("[data-goal-draft]"),
    null,
    "Escape on an empty draft drops it",
  );
});

test("Tab nests a goal one level and Shift+Tab lifts it out", async () => {
  const { store, q, key, top, title, since, calls } = await setup();
  let n = calls().length;
  await key(title("in-4"), "Tab");
  assert.ok(
    since(n).includes(
      `update:union-in-4:${JSON.stringify({ parent_initiative_id: "union-in-2" })}`,
    ),
    "Tab puts it under the goal above",
  );
  assert.ok(q("[data-goal-section='in-2'] [data-goal-section='in-4']"));
  n = calls().length;
  await key(title("in-5"), "Tab");
  assert.equal(
    since(n).filter((c) => c.includes("parent_initiative_id")).length,
    0,
    "never deeper than one level",
  );
  await key(title("in-4"), "Tab", { shiftKey: true });
  assert.equal(
    top().indexOf("in-4"),
    top().indexOf("in-2") + 1,
    "Shift+Tab lifts it out to right after its parent",
  );
  await key(title("in-2"), "Tab");
  assert.ok(
    !store.getState().initiatives["union-in-2"].parent_initiative_id,
    "a goal with goals under it stays at the top",
  );
});

test("the move shortcuts reorder sibling goals", async () => {
  const { key, top, title } = await setup();
  const before = top();
  await key(title("in-2"), "ArrowDown", { metaKey: true, shiftKey: true });
  assert.deepEqual(
    top(),
    [before[1], before[0], ...before.slice(2)],
    "moved one down",
  );
  await key(title("in-2"), "ArrowUp", { metaKey: true, shiftKey: true });
  assert.deepEqual(top(), before, "and back");
});

test("the reason for a goal can be edited in place", async () => {
  const { q, W, type, blur, since, calls } = await setup();
  const n = calls().length;
  await act(async () => {
    q("[data-goal-section='in-1'] [data-goal-why]")!.dispatchEvent(
      new W.MouseEvent("click", { bubbles: true }),
    );
  });
  const why = q<HTMLTextAreaElement>(
    "[data-goal-section='in-1'] textarea[data-goal-why]",
  )!;
  assert.ok(why, "a click opens the words for writing");
  await type(why, "Nobody can run what nobody owns.");
  await blur(why);
  assert.deepEqual(since(n), [
    `update:union-in-1:${JSON.stringify({ why: "Nobody can run what nobody owns." })}`,
  ]);
});

test("a project drag moves it between goals as one undo", async () => {
  const { q, W, since, calls } = await setup();
  const data = {
    effectAllowed: "",
    dropEffect: "",
    setData() {},
    getData: () => "",
  };
  const drag = async (el: Element, type: string, data: object) => {
    await act(async () => {
      const e = new W.Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(e, "dataTransfer", { value: data });
      el.dispatchEvent(e);
    });
  };
  const n = calls().length;
  await drag(
    q("[data-goal-project='union-proj-quality'] [data-project-handle]")!,
    "dragstart",
    data,
  );
  const tail =
    q("[data-goal-projects='in-2'] [data-project-drop-tail]") ??
    q("[data-goal-section='in-2'] [data-project-drop-tail]");
  assert.ok(tail, "while a project is held, every goal offers a place for it");
  await drag(tail!, "dragover", data);
  await drag(tail!, "drop", data);
  assert.ok(
    since(n).includes("remove:union-in-1:union-proj-quality") &&
      since(n).includes("add:union-in-2:union-proj-quality"),
    "it leaves the first goal for the second, as one undo",
  );
  assert.match(getUndoHistory().items[0]?.label ?? "", /^Moved/);
});

test("a live goal measure shows the latest series value and unit", async () => {
  const { q } = await setup();
  const live = q(
    "[data-goal-section='in-2'] [data-goal-numbers] [data-metric-live='mw-7']",
  );
  assert.ok(live, "the live number is marked as live");
  assert.match(
    live!.closest("[data-metric]")!.textContent!,
    /14 brokers/,
    "and reads the series' latest value in its unit",
  );
});

test("a project measure can read from a series", async () => {
  const { q, W, since, calls } = await setup();
  const n = calls().length;
  const give = q<HTMLButtonElement>(
    "[data-goal-project='union-proj-network'] [data-project-add-number]",
  )!;
  assert.ok(give, "a project with no number offers to take one");
  await act(async () => give.click());
  const form = q("[data-project-numbers-form='union-proj-network']")!;
  assert.ok(form, "the editor opens under the project");
  const pick = form.querySelector<HTMLSelectElement>(
    "[data-metric-series-pick]",
  )!;
  await act(async () => {
    pick.value = "mw-7";
    pick.dispatchEvent(new W.Event("change", { bubbles: true }));
  });
  const target = form.querySelector<HTMLInputElement>(
    "input[aria-label='Target']",
  )!;
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(
      W.HTMLInputElement.prototype,
      "value",
    )!.set!;
    set.call(target, "40");
    target.dispatchEvent(new W.Event("input", { bubbles: true }));
  });
  await act(async () =>
    [...form.querySelectorAll("button")]
      .find((b) => b.textContent === "Save")!
      .click(),
  );
  const [write] = since(n);
  assert.equal(since(n).length, 1);
  assert.ok(write?.startsWith("project:union-proj-network:"));
  assert.deepEqual(
    JSON.parse(write.slice("project:union-proj-network:".length)),
    {
      metrics: [
        {
          key: "brokers_sending_deals",
          name: "Brokers sending deals",
          target: "40",
          series: "mw-7",
        },
      ],
    },
    "picking a series names the number after it, and Save writes the project",
  );
  assert.ok(
    q("[data-project-numbers='union-proj-network'] [data-metric-live='mw-7']"),
    "the project's number then reads live under its line",
  );
});
