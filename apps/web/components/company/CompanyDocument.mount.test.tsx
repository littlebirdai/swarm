import { expectAbsent } from "../../test-helpers/domExpect";
import { api } from "@codecast/convex/convex/_generated/api";
import { afterEach, spyOn, test } from "bun:test";
import { getFunctionName } from "convex/server";
import assert from "node:assert/strict";
import { act, type ComponentProps } from "react";
import { syncMetaKey } from "../../hooks/syncMetaKeys";
import { stampRoster } from "../../lib/activeTeam";
import type { DispatchCallArgs } from "../../lib/dispatchBinding";
import { useInboxStore } from "../../store/inboxStore";
import { webBuilders } from "../../test-helpers/builders";
import { mountWeb } from "../../test-helpers/mountWeb";
import { pending } from "../../test-helpers/testConvex";
import { useChangeLit } from "../org/lines/changeLight";
import { UNION_GOALS_UPDATES } from "../org/goalsFixture";
import * as fx from "./companyFixture";
import { CompanyDocument } from "./CompanyDocument";

const TEAM = "u".repeat(32);
const inTeam = { team_id: TEAM, workspace: "team:" + TEAM };
const fixtures = webBuilders("CompanyDocument.mount.test.tsx");
const initiatives = fx.COMPANY_FIXTURE_INITIATIVES.map((row) => ({
  ...row,
  ...inTeam,
}));
const projects = fx.COMPANY_FIXTURE_PROJECTS.map((row) =>
  fixtures.project.build({ ...row, ...inTeam }),
);
const tasks = fx.COMPANY_FIXTURE_TASKS.map((row) =>
  fixtures.task.build({
    status: row.status ?? undefined,
    project_id: typeof row.project_id === "string" ? row.project_id : undefined,
    source: row.source ?? undefined,
    ...inTeam,
  }),
);

let restoreClock: (() => void) | undefined;
afterEach(() => {
  restoreClock?.();
  restoreClock = undefined;
});

type Props = ComponentProps<typeof CompanyDocument>;

async function setup(options: { tree?: boolean; liveGoal?: string } = {}) {
  const clock = spyOn(Date, "now").mockReturnValue(fx.COMPANY_FIXTURE_NOW);
  restoreClock = () => clock.mockRestore();
  const lit: Record<string, boolean> = {};
  const Card = ({ id }: { id: string }) => {
    lit[id] = useChangeLit([id]);
    return null;
  };
  function View(props: Props) {
    return (
      <>
        <CompanyDocument {...props} />
        <Card id="union-purpose" />
        <Card id="union-staff-outreach" />
      </>
    );
  }
  let web: Awaited<ReturnType<typeof mountWeb>>;
  let visit = 0;
  const show = async (props: Props = {}) => {
    if (web) {
      await web.rerender(<View key={++visit} {...props} />);
      return;
    }
    web = await mountWeb(<View {...props} />, {
      path: "/org",
      dispatch: true,
      setup: (backend, store) => {
        backend.mutation(api.dispatch.dispatch, null);
        store.syncTable("currentUser", {
          _id: "fixture-user-me",
          name: "Ashot Petrosian",
        });
        store.stampSyncLogScope("user:fixture-user-me");
        store.stampSyncLogScope("team:" + TEAM);

        store.syncTable("clientState", { ui: { active_team_id: TEAM } });
        useInboxStore.setState({
          clientStateInitialized: true,
          syncRole: "host",
        });
        store.syncTable("teams", [{ _id: TEAM, name: "Union" }]);
        store.syncTable(
          "teamMembers",
          stampRoster(fx.COMPANY_FIXTURE_ROSTER, TEAM),
        );
        if (options.tree !== false)
          store.syncTable("orgTree", {
            ...fx.COMPANY_FIXTURE_TREE,
            workspace: { ...fx.COMPANY_FIXTURE_TREE.workspace, id: TEAM },
          });
        store.syncTable(
          "initiatives",
          initiatives.map((goal) =>
            options.liveGoal && goal.short_id === "in-4"
              ? { ...goal, _id: options.liveGoal }
              : goal,
          ),
        );
        store.syncTable("projects", projects);
        store.syncTable("tasks", tasks);
        store.syncTable(
          "initiativeUpdates",
          UNION_GOALS_UPDATES.map((row) => ({ ...row, ...inTeam })),
        );
        store.recordSyncMeta(
          syncMetaKey(
            "tasks",
            JSON.stringify({ team_id: TEAM, workspace: "team" }),
          ),
          { backfilledAt: 1 },
        );
        backend.set(api.projects.webList, []);
        backend.set(api.initiatives.webList, pending);
        backend.set(api.initiatives.webUpdates, pending);
        backend.set(api.org.roles, pending);
        backend.set(api.orgProposals.list, pending);
        backend.set(api.orgProposals.get, pending);
      },
    });
  };
  const state = () => useInboxStore.getState();
  let syncedAt = fx.COMPANY_FIXTURE_NOW;
  const syncExpanded = (org_expanded: string[] | undefined) =>
    act(async () => {
      clock.mockReturnValue(++syncedAt);
      state().syncTable("clientState", {
        ui: {
          active_team_id: TEAM,
          org_expanded: org_expanded ?? null,
          "org_expanded:ts": syncedAt,
        },
      });
    });
  const propose = () =>
    act(async () => {
      state().syncTable(
        "orgProposals",
        fx.COMPANY_FIXTURE_PROPOSALS.map(({ changes: _changes, ...row }) => ({
          ...row,
          team_id: TEAM,
        })),
      );
      state().syncTable("orgProposalChanges", fx.COMPANY_FIXTURE_CHANGES);
    });
  const written = () =>
    web.backend.mutations.flatMap(({ args }) => {
      const { action, args: params } = args as DispatchCallArgs;
      if (action === "updateInitiative")
        return ["update:" + params[0] + ":" + JSON.stringify(params[1])];
      if (action === "updateClientUI")
        return ["ui:" + JSON.stringify(params[0])];
      return [];
    });
  const queried = <Ref extends Parameters<typeof getFunctionName>[0]>(
    ref: Ref,
  ) =>
    web.backend.queryRequests
      .filter(({ name }) => name === getFunctionName(ref))
      .map(({ args }) => args);
  const q = <T extends Element = HTMLElement>(sel: string) =>
    document.querySelector<T>(sel);
  const qa = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
  const click = async (
    el: Element | null | undefined,
    msg = "missing element",
  ) => {
    assert.ok(el, msg);
    await act(async () => {
      (el as HTMLElement).dispatchEvent(
        new window.MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          button: 0,
        }),
      );
    });
  };
  const key = async (el: Element | null, k: string) => {
    assert.ok(el);
    await act(async () => {
      el!.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: k,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
  };
  const hover = async (el: Element | null, on: boolean) => {
    assert.ok(el);
    await act(async () => {
      el!.dispatchEvent(
        new window.MouseEvent(on ? "mouseover" : "mouseout", {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
    });
  };
  const none = (el: Element | null | undefined, msg: string) =>
    assert.equal(el == null, true, msg);
  const sections = () =>
    qa("[data-company-section]").map((s) =>
      s.getAttribute("data-company-section"),
    );
  const line = (id: string) => q(`[data-line-id='${id}']`);
  /** A line's cells, by the column each sits in. */
  const cells = (el: Element) =>
    [...el.children]
      .map((c) => c.className.split(" ").find((k) => k.startsWith("ol-")))
      .filter(Boolean);
  const GRID = [
    "ol-chev",
    "ol-glyph",
    "ol-title",
    "ol-owner",
    "ol-state",
    "ol-measure",
    "ol-date",
  ];

  return {
    lastNavigation: () => web.navigationLog.at(-1),
    show,
    q,
    qa,
    line,
    cells,
    GRID,
    sections,
    click,
    key,
    hover,
    none,
    written,
    queried,
    state,
    propose,
    syncExpanded,
    lit,
  };
}

test("the overview shows its live data and opens and syncs goal rows", async () => {
  const {
    show,
    q,
    qa,
    line,
    cells,
    GRID,
    sections,
    click,
    none,
    written,
    queried,
    state,
    syncExpanded,
  } = await setup();
  await show();
  assert.ok(
    queried(api.projects.webList).length &&
      queried(api.orgProposals.list).length,
    "mounts the projects and proposals feeders",
  );
  assert.ok(
    queried(api.org.roles).length && !queried(api.org.tree).length,
    "the roles feeder; the screen's map feeds the live tree into the same home",
  );
  assert.match(
    q("[data-company-article]")!.className,
    /\bol-scope\b/,
    "the article is the container its lines answer to: the room inside its padding, not the pane",
  );
  assert.doesNotMatch(q("[data-company-document]")!.className, /\bol-scope\b/);
  assert.deepEqual(
    qa("[data-company-state] > span").map((c) => c.textContent),
    [
      "4 goals: 2 on track,",
      "1 at risk,",
      "1 not started ·",
      "9 projects,",
      "1 with work moving ·",
      "2 people,",
      "2 agent roles",
    ],
    "each comma part wraps whole, so a narrow pane breaks at a comma and never inside a word",
  );
  assert.ok(
    qa("[data-company-state] > span").every(
      (c) => c.className === "whitespace-nowrap",
    ),
  );
  assert.equal(q("[data-company-name]")!.textContent, "Union");
  assert.equal(
    q("[data-company-state]")!.textContent,
    "4 goals: 2 on track, 1 at risk, 1 not started · 9 projects, 1 with work moving · 2 people, 2 agent roles",
  );
  assert.deepEqual(sections(), ["company", "goals", "unfiled", "people"]);
  none(
    q("[data-company-toc], [data-company-proposals], [data-company-purpose]"),
    "no contents, no proposal banner, no purpose block: the header and the strip say those",
  );

  // Goals: one line each, the top level in the outline's order.
  assert.deepEqual(
    qa(
      "[data-company-section='goals'] [data-company-depth='1'] > [data-line='goal']",
    ).map((l) => l.getAttribute("data-line-ref")),
    ["in-2", "in-4", "in-1"],
  );
  const network = line("union-in-2")!;
  assert.deepEqual(
    cells(network),
    GRID,
    "a goal line fills every column of the grid",
  );
  assert.equal(
    network.querySelector("[data-line-title]")!.getAttribute("href"),
    "/goals/in-2",
  );
  assert.ok(
    network.querySelector("[data-line-owner] [data-initiative-pick='owner'] "),
    "the owner, as the picker the sheet uses",
  );
  assert.equal(
    network
      .querySelector("[data-line-state] [data-initiative-health]")!
      .getAttribute("data-initiative-health"),
    "on_track",
  );
  const metric = network.querySelector(
    "[data-line-measure] [data-metric='brokers']",
  )!;
  assert.equal(metric.getAttribute("data-metric-size"), "line");
  assert.match(
    metric.textContent!,
    /^17 of 40/,
    "now of target, with no name: the column names it",
  );
  assert.doesNotMatch(metric.textContent!, /Brokers onboarded/);
  assert.equal(
    metric
      .querySelector("[data-metric-trend]")!
      .getAttribute("data-metric-trend"),
    "up",
  );
  assert.ok(metric.querySelector("svg"), "the sparkline");
  assert.equal(
    network
      .querySelector("[data-line-date] [data-initiative-target]")!
      .getAttribute("data-initiative-target"),
    "ahead",
  );
  none(
    q("[data-initiative-progress]"),
    "a goal's progress is its metric: no task bar",
  );
  // A goal without a metric or a target day leaves those cells out rather than drawing filler.
  none(
    line("union-in-1")!.querySelector("[data-line-measure], [data-line-date]"),
    "no empty measure or date cell",
  );

  // It opens on the goal at the worst health; the rest are folded.
  assert.deepEqual(
    qa("[data-company-open]").map((g) => g.getAttribute("data-company-goal")),
    ["in-4"],
  );
  assert.equal(line("union-in-4")!.getAttribute("aria-expanded"), "true");
  assert.equal(
    line("union-in-4")!
      .querySelector("[data-line-state] [data-initiative-health]")!
      .getAttribute("data-initiative-health"),
    "at_risk",
    "the line says the word the state line counts and the document opens on, whatever its status",
  );
  assert.equal(network.getAttribute("aria-expanded"), "false");
  assert.match(
    q("[data-company-goal-body='in-4'] [data-company-why]")!.textContent!,
    /^One careless message/,
  );
  assert.ok(
    q("[data-company-goal-body='in-4'] [data-company-update='union-upd-2']"),
    "the owner's latest word",
  );

  // A click on the row opens it in place, and the choice is the person's, written to their synced UI state.
  await click(network.querySelector(".ol-measure"), "the row's background");
  assert.equal(
    written().at(-1),
    `ui:${JSON.stringify({ org_expanded: ["union-in-4", "union-in-2"] })}`,
  );
  assert.equal(line("union-in-2")!.getAttribute("aria-expanded"), "true");
  assert.match(
    q("[data-company-goal-body='in-2'] [data-company-why]")!.textContent!,
    /^Brokers place the deals/,
  );
  assert.ok(
    q("[data-company-goal-body='in-2'] [data-company-update='union-upd-1']"),
  );
  none(
    q("[data-company-refs]"),
    "no run-on sentence of the projects listed under other goals: each is a line where it is listed",
  );
  // What carries it, one level in: its project line, then the goal that feeds it, each on the same columns.
  const pr6 = line("union-proj-network")!;
  assert.equal(pr6.getAttribute("aria-level"), "2");
  // A quiet active project leaves its state cell out (the column speaks only when something happens); the grid areas hold the rest in place.
  assert.deepEqual(
    cells(pr6),
    GRID.filter((c) => c !== "ol-state"),
  );
  none(q("[data-project-status='active']"), "no project line says active");
  assert.match(
    pr6.getAttribute("style")!,
    /--ol-indent: 18px/,
    "depth indents inside the first column, so every other column holds",
  );
  assert.equal(
    pr6.querySelector("[data-line-measure]")!.textContent,
    "12 of 21 tasks",
    "the board's count: dropped and agent rows are not in it",
  );
  assert.ok(
    pr6.querySelector("[data-line-owner] [data-project-lead] button"),
    "the editable lead chip",
  );
  assert.match(
    pr6.querySelector("[data-project-glyph]")!.className,
    /bg-sol-blue/,
    "a diamond in the project's colour",
  );
  assert.equal(line("union-in-5")!.getAttribute("aria-level"), "2");
  // The chevron folds it back.
  await click(line("union-in-2")!.querySelector("[data-line-chev]"));
  assert.equal(
    written().at(-1),
    `ui:${JSON.stringify({ org_expanded: ["union-in-4"] })}`,
  );
  // A second window reads the same synced state and opens the same lines.
  await syncExpanded(["union-in-2", "union-in-5", "gone-goal"]);
  await show();
  assert.deepEqual(
    qa("[data-company-open]").map((g) => g.getAttribute("data-company-goal")),
    ["in-2", "in-5"],
    "what was opened elsewhere is open here; the stale id opens nothing",
  );
});

test("the owner and status pickers update the row in place", async () => {
  const { show, q, qa, line, click, key, written, state, syncExpanded } =
    await setup();
  await show();
  await syncExpanded(["union-in-2"]);
  await show();
  const pick = async (id: string, which: string, label: RegExp) => {
    const scope = line(id)!.querySelector("[data-line-" + which + "]");
    await click(scope?.querySelector("button"));
    return qa("[role=dialog] button").find((b) =>
      label.test(b.textContent ?? ""),
    );
  };
  await click(
    await pick("union-in-2", "state", /^Planned$/),
    "the status list",
  );
  assert.equal(
    written().at(-1),
    `update:union-in-2:${JSON.stringify({ status: "planned" })}`,
  );
  assert.equal(
    state().initiatives["union-in-2"].status,
    "planned",
    "the pick is in the store at once",
  );
  assert.equal(
    line("union-in-2")!
      .querySelector("[data-line-state] [data-initiative-health]")!
      .getAttribute("data-initiative-health"),
    "on_track",
    "a planned goal its owner has spoken on still shows their word",
  );
  assert.ok(await pick("union-in-2", "state", /^Not started$/));
  await key(q("[role=dialog]"), "Escape");
  assert.equal(
    line("union-in-2")!.getAttribute("aria-expanded"),
    "true",
    "a pick is the control's own click, never the row's",
  );
  await click(await pick("union-in-2", "owner", /Samvit/), "the owner list");
  assert.equal(
    written().at(-1),
    `update:union-in-2:${JSON.stringify({ owner: { kind: "user", user_id: "fixture-user-samvit" } })}`,
  );
  assert.match(
    line("union-in-2")!.querySelector("[data-line-owner]")!.textContent!,
    /Samvit/,
  );
});

test("a line navigates by title and expands with the arrow keys", async () => {
  const { show, lastNavigation, line, click, key, written, syncExpanded } =
    await setup();
  await show();
  await syncExpanded(["union-in-2", "union-in-5", "gone-goal"]);
  await show();
  assert.equal(
    line("union-in-1")!.querySelector(
      "[data-line-owner] [data-initiative-owner] .truncate",
    )?.textContent,
    "Head of People",
  );
  await key(line("union-in-1"), "Enter");
  assert.deepEqual(lastNavigation(), { path: "/goals/in-1", action: "push" });
  await click(line("union-in-2")!.querySelector("[data-line-title]"));
  assert.equal(line("union-in-2")!.getAttribute("aria-expanded"), "true");
  // Space and the arrows open and fold in place.
  await key(line("union-in-1"), "ArrowRight");
  assert.equal(
    written().at(-1),
    `ui:${JSON.stringify({ org_expanded: ["union-in-2", "union-in-5", "gone-goal", "union-in-1"] })}`,
  );
});

test("unfiled projects show trouble without a count for projects without tasks", async () => {
  const { show, q, qa, line, none, syncExpanded } = await setup();
  await show();
  assert.deepEqual(
    qa("[data-company-section='unfiled'] [data-line='project']").map((l) =>
      l.getAttribute("data-line-ref"),
    ),
    ["pr-2", "pr-3", "pr-4", "pr-1", "pr-9", "pr-8"],
  );
  const callers = line("union-proj-callers")!;
  assert.equal(
    callers.getAttribute("data-expandable"),
    "true",
    "past its target with work left",
  );
  assert.equal(
    line("union-proj-cameron")!.getAttribute("data-expandable"),
    null,
    "nothing to say, nothing to open",
  );
  await syncExpanded(["union-proj-callers", "union-proj-infra"]);
  await show();
  assert.equal(
    q("[data-project-body='pr-2'] [data-project-trouble]")!.textContent,
    "Past its target",
  );
  assert.equal(
    q("[data-project-body='pr-4'] [data-project-trouble]")!.textContent,
    "1 risk in its charter",
  );
  none(
    q("[data-line-id='union-proj-infra'] [data-line-measure]"),
    "no tasks counted, no count",
  );
});

test("people and roles show the reporting outline and the goals they carry", async () => {
  const { show, q, qa, line, cells, GRID, click, none } = await setup();
  await show();
  assert.deepEqual(
    qa("[data-company-section='people'] [data-line]").map(
      (l) => `${l.getAttribute("data-line")}:${l.getAttribute("aria-level")}`,
    ),
    ["person:1", "role:2", "role:2", "person:1"],
  );
  assert.equal(
    q("[data-company-section='people'] [data-company-count]")!.textContent,
    "2 people · 2 roles",
  );
  const ashot = line("fixture-user-me")!;
  assert.deepEqual(cells(ashot), GRID);
  assert.equal(
    ashot.querySelector("[data-line-title]")!.getAttribute("href"),
    "/org/@ashot",
  );
  assert.equal(ashot.querySelector("[data-line-sub]")!.textContent, "you");
  assert.equal(
    ashot.querySelector("[data-person-access]")!.textContent,
    "owner",
  );
  assert.equal(
    ashot
      .querySelector("[data-person-presence]")!
      .getAttribute("data-person-presence"),
    "online",
  );
  assert.equal(
    ashot.querySelector("[data-person-carries]")!.textContent,
    "1 goal · 5 sessions at work, 4 waiting on input",
    "the roles are the lines right under it: not counted again; only live sessions count",
  );
  assert.equal(
    ashot.querySelector("[data-person-since]")!.textContent,
    "since Jan",
  );
  const quality = line("fixture-role-agent-quality")!;
  assert.deepEqual(
    cells(quality),
    GRID.filter((c) => c !== "ol-owner"),
    "the owner cell left empty, every other column held",
  );
  assert.equal(
    quality.querySelector("[data-line-title]")!.getAttribute("href"),
    "/org/or-36",
  );
  none(
    quality.querySelector("[data-role-reports-to]"),
    "it sits right under whom it reports to: the line does not name them again",
  );
  assert.equal(
    quality.querySelector("[data-role-state]")!.getAttribute("data-role-state"),
    "dormant",
    "its standing agent's own word",
  );
  assert.equal(
    quality.querySelector("[data-role-carries]")!.textContent,
    "leads Agent Quality",
  );
  assert.equal(
    line("fixture-role-head-of-people")!.querySelector("[data-role-carries]")!
      .textContent,
    "owns Every project has a lead and every goal an owner",
  );
  // A person opens in place to the goals they own, as goal lines.
  await click(ashot.querySelector("[data-line-chev]"));
  assert.ok(
    q(
      "[data-company-person='fixture-user-me'] [data-line-id='union-in-2'][aria-level='2']",
    ),
  );
});

test("filters keep the column order and mark the selected line", async () => {
  const { show, qa, line, cells, GRID, sections } = await setup();
  // A line draws only the cells it has something for, always in the grid's order: the columns hold still.
  const lineCells = () =>
    qa("[data-line]:not([data-ghost])").map((l) => cells(l) as string[]);
  const onGrid = (c: string[]) =>
    c.slice(0, 3).join(" ") === "ol-chev ol-glyph ol-title" &&
    c.every((k, i) => i === 0 || GRID.indexOf(k) > GRID.indexOf(c[i - 1]));
  await show({ filter: "goals" });
  // The Goals page lists goals only; projects under no goal are on the Projects page.
  assert.deepEqual(sections(), ["company", "goals"]);
  assert.ok(lineCells().every(onGrid));
  await show({ filter: "projects" });
  assert.deepEqual(sections(), ["company", "projects"]);
  assert.deepEqual(
    qa("[data-company-project-group]").map((g) =>
      g.getAttribute("data-company-project-group"),
    ),
    ["in-2", "in-5", "in-1", "unfiled"],
  );
  assert.equal(
    qa("[data-company-section='projects'] [data-line='project']").length,
    9,
    "every project once",
  );
  assert.equal(
    qa("[data-line='goal']").length,
    0,
    "goals are headings here, not lines",
  );
  assert.ok(lineCells().every(onGrid));
  await show({ filter: "people" });
  assert.deepEqual(sections(), ["company", "people"]);
  assert.ok(lineCells().every(onGrid));
  // The line under the top sheet is marked, so the document stays live beside it.
  await show({ selected: "or-36" });
  assert.equal(
    line("fixture-role-agent-quality")!.getAttribute("data-selected"),
    "true",
  );
});

test("proposals show pending changes and highlight the corresponding card", async () => {
  const {
    show,
    q,
    qa,
    line,
    sections,
    click,
    hover,
    none,
    queried,
    propose,
    syncExpanded,
    lit,
  } = await setup();
  await show();
  await propose();
  await syncExpanded(undefined);
  await show();
  assert.ok(
    queried(api.orgProposals.get).some((args) =>
      JSON.stringify(args).includes("op-54"),
    ) &&
      queried(api.orgProposals.get).some((args) =>
        JSON.stringify(args).includes("op-55"),
      ),
    "one feeder for each open proposal",
  );
  assert.equal(
    q("[data-company-state]")!.textContent,
    "4 goals: 2 on track, 1 at risk, 1 not started · 9 projects, 1 with work moving · 2 people, 2 agent roles",
    "nothing proposed is counted as held",
  );
  // The company as it is stays the base: the counts are the live ones, with what the proposal would add said apart.
  assert.deepEqual(
    sections(),
    ["company", "goals", "unfiled", "people"],
    "a project only a proposal places is still loose",
  );
  assert.equal(
    q("[data-company-section='goals'] [data-company-count]")!.textContent,
    "4 · 7 proposed",
  );
  assert.deepEqual(
    qa(
      "[data-company-section='goals'] [data-company-depth='1'] > [data-line='goal']:first-child",
    ).map((l) => l.getAttribute("data-line-id")),
    ["union-in-2", "union-in-4", "union-in-1", "union-purpose"],
  );
  const purpose = line("union-purpose")!;
  assert.equal(purpose.getAttribute("data-ghost"), "");
  assert.equal(
    purpose.querySelector("[data-line-title]")!.textContent,
    "Broker high-value introductions that become real transactions",
  );
  assert.equal(
    purpose.querySelector("[data-line-title]")!.tagName,
    "SPAN",
    "a proposed goal has no sheet to open yet",
  );
  const answer = purpose.querySelector("[data-line-answer]")!;
  assert.equal(answer.textContent, "op-54 · answer in the conversation");
  assert.equal(answer.getAttribute("href"), "/org?proposal=op-54&focus=1");
  assert.equal(
    purpose.getAttribute("aria-expanded"),
    "false",
    "it opens on the live goal at the worst health, never on a proposal",
  );
  // A live goal the proposal would move keeps its place, and its own line says where it would go.
  assert.equal(line("union-in-2")!.getAttribute("data-ghost"), null);
  const move = line("union-in-2")!.querySelector("[data-company-goal-move]")!;
  assert.equal(
    move.textContent,
    "",
    'an arrow, not words: the line it moves to says "moves here"',
  );
  assert.match(
    move.getAttribute("aria-label")!,
    /^moves under Broker high-value/,
  );
  assert.match(
    move.getAttribute("title")!,
    /^op-54 would move it under Broker high-value/,
  );
  // Opened, the proposed goal names the live goals that would come under it (each opens) and the goals it sets.
  await click(purpose.querySelector("[data-line-chev]"));
  assert.deepEqual(
    qa("[data-company-arriving]").map((a) =>
      a.getAttribute("data-company-arriving"),
    ),
    ["in-2", "in-4", "in-1"],
  );
  const arriving = line("arriving:union-in-2")!;
  assert.equal(
    arriving.querySelector("[data-line-title]")!.getAttribute("href"),
    "/goals/in-2",
    "a real goal a proposal would move opens like any other",
  );
  assert.equal(
    arriving.querySelector("[data-line-sub]")!.textContent,
    "moves here",
  );
  assert.equal(
    arriving.querySelector("[data-line-answer]")!.getAttribute("href"),
    null,
    "the line above already says where it is answered",
  );
  assert.equal(line("union-revenue")!.getAttribute("data-ghost"), "");
  none(
    q("[data-company-change='union-network']"),
    "a goal's own move is never a line under it",
  );
  // Hovering a proposal's line lights its card in the conversation; leaving puts it out.
  assert.equal(lit["union-purpose"], false);
  await hover(line("union-purpose"), true);
  assert.equal(lit["union-purpose"], true);
  await hover(line("union-purpose"), false);
  assert.equal(lit["union-purpose"], false);
  // A role it would hire stands under who it would report to.
  const hire = q(
    "[data-company-ghost-role='union-staff-outreach'] [data-line='role']",
  )!;
  assert.equal(hire.getAttribute("aria-level"), "2");
  assert.equal(
    hire.querySelector("[data-line-title]")!.textContent,
    "Broker Outreach Lead",
  );
  // The change just above it is the same proposal's and says where to answer it; this one does not repeat it.
  assert.equal(
    q(
      "[data-company-ghost-role='union-staff-quality-scope'] [data-line-answer]",
    )!.getAttribute("href"),
    "/org?proposal=op-55&focus=2",
  );
  assert.equal(
    hire.querySelector("[data-line-answer]")!.getAttribute("href"),
    null,
  );
  const scope = q(
    "[data-company-ghost-role='union-staff-quality-scope'] [data-line][aria-level='3']",
  )!;
  assert.ok(scope, "a change on a role, one level under it");
  assert.equal(
    scope.querySelector("[data-line-title]")!.textContent,
    "would lead Callers & Call Management",
    "said from the role's line, which already names the role",
  );
  none(scope.querySelector("[data-line-sub]"), "no repeated role name");
  assert.ok(
    scope.querySelector("[data-project-glyph]"),
    "the project glyph, not the role's face again",
  );
  await hover(hire, true);
  assert.equal(lit["union-staff-outreach"], true);
  await hover(hire, false);
  none(
    q(
      "[data-subject-approve], [data-subject-reject], [data-subject-reply], [data-subject]",
    ),
    "nothing to answer here",
  );
});

test("a project listed under two goals expands separately", async () => {
  const { show, qa, click, propose, syncExpanded } = await setup();
  await show();
  await propose();
  await syncExpanded([]);
  await show({ filter: "projects" });
  const twice = qa(
    "[data-company-section='projects'] [data-line='project']",
  ).filter((l) => l.getAttribute("data-line-ref") === "pr-12");
  assert.equal(twice.length, 2, "listed under both goals");
  expectAbsent(twice[0].querySelector("[data-company-also-under]"));
  assert.match(
    twice[1].querySelector("[data-company-also-under]")!.textContent!,
    /^also under Every relationship/,
  );
  await click(twice[0].querySelector("[data-line-chev]"));
  assert.deepEqual(
    qa("[data-company-section='projects'] [data-line-ref='pr-12']").map((l) =>
      l.getAttribute("aria-expanded"),
    ),
    ["true", "false"],
    "keyed by where it is drawn, not by the project alone",
  );
});

test("done projects stay folded unless opened or selected", async () => {
  const { show, q, qa, click, none, state, syncExpanded } = await setup();
  await show({ filter: "projects" });
  const group = q("[data-company-project-group='in-2']")!;
  const doneId = group
    .querySelector("[data-line='project']")!
    .getAttribute("data-line-id")!;
  const before = projects;
  await act(async () =>
    state().syncTable(
      "projects",
      before.map((p) => (p._id === doneId ? { ...p, status: "done" } : p)),
    ),
  );
  await show({ filter: "projects" });
  const fold = q(
    "[data-company-project-group='in-2'] [data-company-done-fold]",
  );
  assert.equal(fold?.getAttribute("data-company-done-fold"), "closed");
  assert.match(fold!.textContent!, /^1 done$/);
  none(
    q(`[data-company-project-group='in-2'] [data-line-id='${doneId}']`),
    "a done project is folded away",
  );
  await click(fold);
  assert.equal(
    q(
      "[data-company-project-group='in-2'] [data-company-done-fold]",
    )!.getAttribute("data-company-done-fold"),
    "open",
  );
  const lines = qa("[data-company-project-group='in-2'] [data-line='project']");
  assert.equal(
    lines.at(-1)!.getAttribute("data-line-id"),
    doneId,
    "below the active ones",
  );
  // Every real project line carries its pin, off until pinned.
  assert.ok(lines.every((l) => l.querySelector("[data-project-pin='off']")));
  // The fold opens on its own when it holds the selected project.
  await syncExpanded([]);
  await show({ filter: "projects", selected: doneId });
  assert.equal(
    q(
      "[data-company-project-group='in-2'] [data-company-done-fold]",
    )!.getAttribute("data-company-done-fold"),
    "open",
  );
  assert.ok(
    q(
      `[data-company-project-group='in-2'] [data-line-id='${doneId}'][data-selected]`,
    ),
  );
});

test("the roster supplies the people before the org tree arrives", async () => {
  const { show, q, qa, none } = await setup({ tree: false });
  await show();
  await show();
  assert.equal(q("[data-company-name]")!.textContent, "Union");
  assert.deepEqual(
    qa(
      "[data-company-section='goals'] [data-company-depth='1'] > [data-line='goal']",
    ).map((l) => l.getAttribute("data-line-ref")),
    ["in-2", "in-4", "in-1"],
  );
  assert.equal(qa("[data-line='role']").length, 0);
  assert.equal(qa("[data-line='person']").length, 2, "the roster's people");
  none(q("[data-ghost]"), "no tree, no ghosts");
});

test("an empty workspace omits empty sections", async () => {
  const { show, q, sections, state } = await setup({ tree: false });
  await show();
  await act(async () => {
    state().dropRows("initiatives", Object.keys(state().initiatives));
    state().dropRows("projects", Object.keys(state().projects));
  });
  await show();
  assert.deepEqual(sections(), ["company", "people"]);
  await show({ filter: "goals" });
  assert.deepEqual(sections(), ["company"]);
  assert.equal(q("[data-company-empty]")!.textContent, "No goals.");
});

test("opening a cached goal subscribes to that goal's updates", async () => {
  const goal = fixtures.plan.build()._id;
  const { show, queried } = await setup({ liveGoal: goal });
  await show();
  assert.deepEqual(queried(api.initiatives.webUpdates), [
    { initiative_id: goal },
  ]);
});
