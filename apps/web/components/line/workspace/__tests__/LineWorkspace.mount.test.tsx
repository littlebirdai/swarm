import { api } from "@codecast/convex/convex/_generated/api";
import { beforeEach, expect, test } from "bun:test";
import React, { act } from "react";
import { useInboxStore } from "../../../../store/inboxStore";
import { holdLineWorkspaceFeeds } from "../../../../test-helpers/lineWorkspaceBackend";
import { mountWeb } from "../../../../test-helpers/mountWeb";
import { pending } from "../../../../test-helpers/testConvex";
import LineFence from "../../widgets/LineFence";
import { LineWorkspace } from "../LineWorkspace";

let search = "";
const ME = "u1";
const WS = `user:${ME}`;
const now = Date.now();
const DAY = 86_400_000;
const project = {
  _id: "p1",
  short_id: "pr-1",
  title: "Codecast",
  workspace: WS,
  line_profile: {
    finders: [],
    root: "/repo",
    default: false,
    changed_at: now - 1000,
  },
};
const n = (node_id: string, i: number, status = "completed") => ({
  node_id,
  status,
  started_at: now - 2 * DAY + i * 60_000,
  completed_at: now - 2 * DAY + i * 60_000 + 30_000,
});
const nodes = [
  { id: "ground", h: "aaaa1111" },
  { id: "prove", h: "bbbb2222" },
  { id: "decide", h: "cccc3333" },
];
const run = (
  id: string,
  at: number,
  statuses: ReturnType<typeof n>[],
  status = "completed",
) => ({
  _id: id,
  status,
  task_id: "t1",
  workflow_slug: "line",
  workflow_name: "line",
  workspace: WS,
  project_id: "p1",
  graph_hash: "1111",
  graph_nodes: nodes,
  node_statuses: [n("start", 0), ...statuses],
  created_at: at,
  updated_at: at + 1000,
});

type Seed = (store: ReturnType<typeof useInboxStore.getState>) => void;
function seed(store: Parameters<Seed>[0]) {
  store.syncTable("currentUser", { _id: ME, name: "Me" });
  useInboxStore.setState({ clientStateInitialized: true });
  store.syncTable("teams", [
    { _id: "team1", name: "Team", features: { line: true } },
  ]);
  store.syncTable("projects", [
    project,
    {
      ...project,
      _id: "outside",
      short_id: "pr-2",
      title: "Other project",
      workspace: "user:away",
    },
  ]);
  store.syncTable("tasks", [
    {
      _id: "t1",
      short_id: "ct-1",
      title: "Sidebar freezes on resume",
      status: "in_progress",
      workspace: WS,
      project_id: "p1",
      created_at: now - 3 * DAY,
      updated_at: now,
      cause: {
        signal_count: 2,
        first_seen: now - 3 * DAY,
        last_seen: now - DAY,
      },
    },
  ]);
  store.syncTable("workflowRuns", [
    run("a", now - 2 * DAY, [n("ground", 1), n("prove", 2), n("decide", 3)]),
  ]);
}

async function mount(el: React.ReactElement, extra?: Seed) {
  const web = await mountWeb(el, {
    path: "/flows" + (search ? "?" + search : ""),
    authenticated: true,
    setup(backend, store) {
      window.innerWidth = 1400;
      seed(store);
      extra?.(store);
      holdLineWorkspaceFeeds(backend);
      backend.set(api.sessionDecisions.get, pending);
      backend.set(api.sessionDecisions.getWithDoc, pending);
      backend.set(api.workflow_runs.get, pending);
      backend.set(api.appConnections.listConnections, pending);
      backend.set(api.ingest.listSources, pending);
      backend.set(api.lineStages.flow, pending);
    },
  });
  return { ...web, host: web.container };
}

beforeEach(() => {
  search = "";
});

const key = (k: string) =>
  act(async () => {
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: k, bubbles: true }),
    );
  });

test("the bare address is the team's pipelines; with no live flow the Flows stage is the library, and a flow the address names opens on its map", async () => {
  search = "";
  const landing = await mount(React.createElement(LineWorkspace));
  expect(
    landing.host
      .querySelector("[data-pipelines-link]")
      ?.getAttribute("aria-current"),
  ).toBe("page");
  expect(
    landing.host
      .querySelector("[data-pipeline-stage='flows']")
      ?.getAttribute("aria-current"),
  ).toBeNull();
  await landing.close();
  search = "view=flows";
  const lib = await mount(React.createElement(LineWorkspace));
  expect(
    lib.host
      .querySelector("[data-pipeline-stage='flows']")
      ?.getAttribute("aria-current"),
  ).toBe("page");
  expect(lib.host.querySelector("[data-flows-home]")).not.toBeNull();
  await lib.close();
  search = "graph=line";
  const { host, close, navigationLog } = await mount(
    React.createElement(LineWorkspace),
  );
  expect(
    host
      .querySelector("[data-pipeline-stage='flows']")
      ?.getAttribute("aria-current"),
  ).toBe("page");
  expect(host.querySelector("[data-line-view='graph']")).not.toBeNull();
  expect(
    host.querySelector("[data-line-mode='map']")?.getAttribute("aria-selected"),
  ).toBe("true");
  await close();
}, 30_000);

test("the nav: For you first with its count, then the stages on a rail, the open one marked; G then a letter opens a stage, a digit never does", async () => {
  search = "view=flows";
  const { host, close, navigationLog } = await mount(
    React.createElement(LineWorkspace),
    (store) => {
      store.syncTable("sessionDecisions", [
        {
          _id: "d1",
          short_id: "sd-9",
          status: "pending",
          blocking: true,
          task_id: "t1",
          workflow_run_id: "a",
          created_at: now - 3_600_000,
          question: "Ship it?",
          options: [{ label: "Ship" }, { label: "Drop" }],
        },
        {
          _id: "decoy",
          short_id: "sd-99",
          status: "answered",
          blocking: true,
          task_id: "t1",
          workflow_run_id: "a",
          created_at: now - 3_600_000,
          question: "Already answered?",
          options: [{ label: "No" }],
        },
      ]);
    },
  );
  expect(
    [...host.querySelectorAll<HTMLElement>("[data-pipeline-stage]")].map(
      (b) => b.dataset.pipelineStage,
    ),
  ).toEqual(["decisions", "volume", "signals", "problems", "flows", "shipped"]);
  expect(
    [
      ...host.querySelectorAll<HTMLElement>(
        "[data-pipeline-rail] [data-pipeline-stage]",
      ),
    ].map((b) => b.dataset.pipelineStage),
  ).toEqual(["signals", "problems", "flows", "shipped"]);
  // The library sits under Flows.
  expect(
    host
      .querySelector("[data-pipeline-stage='flows']")
      ?.getAttribute("aria-current"),
  ).toBe("page");
  expect(host.querySelector("[data-flows-home]")).not.toBeNull();
  // For you counts what the viewer can answer now; no process picker, and the project filter only on Problems.
  expect(
    host.querySelector("[data-pipeline-stage='decisions'] .pn-label")
      ?.textContent,
  ).toBe("Decisions");
  expect(
    host.querySelector("[data-pipeline-stage='decisions'] .pn-n")?.textContent,
  ).toBe("1");
  expect(host.querySelector("[data-line-view-tab]")).toBeNull();
  expect(host.querySelector("[data-line-graph-pick]")).toBeNull();
  expect(host.querySelector("[data-line-project-filter]")).toBeNull();
  // Digits belong to an open decision's answers: the shell moves on none of them.
  await key("2");
  await key("3");
  expect(navigationLog.slice(1)).toEqual([]);
  await key("g");
  await key("f");
  expect(navigationLog.slice(1)).toEqual([]);
  await key("g");
  await key("p");
  expect(navigationLog.at(-1)).toEqual({
    action: "push",
    path: "/flows?view=problems",
  });
  await key("g");
  await key("s");
  expect(navigationLog.at(-1)).toEqual({
    action: "push",
    path: "/flows?view=signals",
  });
  await close();
}, 30_000);

test("an address naming a flow decision opens it on the Decisions page, in place", async () => {
  search = "need=sd-9";
  const { close, navigationLog } = await mount(
    React.createElement(LineWorkspace),
  );
  expect(navigationLog.slice(1)).toContainEqual({
    action: "replace",
    path: "/decisions/sd-9",
  });
  expect(navigationLog.filter(({ action }) => action === "push")).toEqual([]);
  await close();
}, 30_000);

test("Problems carries the project filter, and only Problems", async () => {
  search = "project=pr-1&view=problems";
  const { host, close } = await mount(React.createElement(LineWorkspace));
  expect(host.querySelector("[data-line-project-filter]")?.textContent).toBe(
    "Codecast",
  );
  expect(
    host
      .querySelector("[data-pipeline-stage='problems']")
      ?.getAttribute("aria-current"),
  ).toBe("page");
  await close();
  search = "view=foryou";
  const other = await mount(React.createElement(LineWorkspace));
  expect(other.host.querySelector("[data-line-project-filter]")).toBeNull();
  await other.close();
}, 30_000);

test("the Line's Decisions is the Decisions page narrowed to the flows, and an older address opens its decision there", async () => {
  search = "view=foryou";
  const { host, close, navigationLog } = await mount(
    React.createElement(LineWorkspace),
  );
  expect(host.querySelector("[data-decision-row]")).toBeNull();
  expect(navigationLog.slice(1)).toContainEqual({
    action: "replace",
    path: "/decisions?tab=team&source=flows",
  });
  expect(navigationLog.filter(({ action }) => action === "push")).toEqual([]);
  await close();
  search = "view=inbox&decision=sd-9";
  const again = await mount(React.createElement(LineWorkspace));
  expect(again.navigationLog.slice(1)).toContainEqual({
    action: "replace",
    path: "/decisions/sd-9",
  });
  expect(again.navigationLog.filter(({ action }) => action === "push")).toEqual(
    [],
  );
  await again.close();
}, 30_000);

test("a line fence draws the live step, and an unreadable project says so", async () => {
  search = "";
  const { host, close, navigationLog } = await mount(
    React.createElement(LineFence, {
      code: JSON.stringify({ widget: "step", project: "pr-1", step: "prove" }),
    }),
  );
  const card = host.querySelector<HTMLElement>("[data-line-widget='step']");
  expect(card?.dataset.lineStep).toBe("prove");
  expect(card?.querySelector(".lw-obj-title")?.textContent).toBe("Prove");
  const open = card?.querySelector<HTMLAnchorElement>(".lw-obj-foot a");
  expect(open?.getAttribute("href")).toBe(
    "/flows?project=pr-1&graph=line&step=prove",
  );
  await close();

  const other = await mount(
    React.createElement(LineFence, {
      code: JSON.stringify({
        widget: "step",
        project: "pr-404",
        step: "prove",
      }),
    }),
  );
  expect(
    other.host.querySelector("[data-line-fence-fallback]")?.textContent,
  ).toContain("not one you can open");
  await other.close();

  const bad = await mount(
    React.createElement(LineFence, { code: "{ not json" }),
  );
  expect(bad.host.querySelector("[data-line-widget]")).toBeNull();
  expect(bad.host.textContent).toContain("not json");
  await bad.close();

  // With Flows off the block reads as its source.
  const off = await mount(
    React.createElement(LineFence, {
      code: JSON.stringify({ widget: "step", project: "pr-1", step: "prove" }),
    }),
    (store) =>
      store.syncTable("teams", [
        { _id: "team1", name: "Team", features: { line: false } },
      ]),
  );
  expect(off.host.querySelector("[data-line-widget]")).toBeNull();
  expect(off.host.textContent).toContain('"widget"');
  await off.close();
}, 30_000);

test("on the Map a station slides in as a drawer over the graph, Esc closes it; the Table's step stays a page", async () => {
  search = "project=pr-1&view=line&mode=map&graph=line&step=prove";
  const { host, close, navigationLog } = await mount(
    React.createElement(LineWorkspace),
  );
  expect(host.querySelector("[data-line-drawer]")).not.toBeNull();
  // The graph stays drawn behind it.
  expect(host.querySelector("[data-line-view='graph']")).not.toBeNull();
  expect(host.querySelector(".lw-body")?.hasAttribute("data-drawer-open")).toBe(
    true,
  );
  await key("Escape");
  expect(navigationLog.at(-1)).toEqual({
    action: "push",
    path: "/flows?project=pr-1&graph=line",
  });
  await close();

  search = "project=pr-1&view=line&graph=line&step=prove";
  const table = await mount(React.createElement(LineWorkspace));
  expect(table.host.querySelector("[data-line-drawer]")).toBeNull();
  expect(table.host.querySelector("[data-line-view='graph']")).toBeNull();
  await table.close();
}, 30_000);

test("a review stage opens its drawer over Signals; nothing arriving is said plainly", async () => {
  search = "project=pr-1&view=signals&graph=line&stage=moments";
  const { host, close, navigationLog } = await mount(
    React.createElement(LineWorkspace),
    (store) =>
      store.syncTable("lineStages", [
        {
          _id: "p1",
          project: "Codecast",
          sources: ["union-moments"],
          window: { moments: 3, capped: false },
          days: 14,
          at: now,
          kinds: [
            {
              kind: "call",
              source: "union-moments",
              extractor: null,
              counts: { waiting: 0, extracting: 0, ready: 3, failed: 0 },
              total: 3,
              day: 0,
              week: 3,
              newest_at: now - 5 * DAY,
              newest_event_at: now - 8 * DAY,
              days: [0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0],
              replayed: 3,
              gap_ms: null,
              versions: [],
              recent: [],
              failed: [],
            },
          ],
          judges: [],
          retired: { week: 0, recent: [] },
          grouping: {
            attach: 0.86,
            ask: 0.45,
            hits: 64,
            candidates: 5,
            cross_ask: 0.5,
            cross_candidates: 3,
            embedding_model: "e",
            attach_model: "m",
          },
        },
      ]),
  );
  expect(host.querySelector("[data-line-drawer='Moments']")).not.toBeNull();
  expect(
    host.querySelector("[data-line-moments-quiet]")?.textContent,
  ).toContain("Nothing arriving");
  expect(
    host
      .querySelector("[data-pipeline-stage='signals']")
      ?.getAttribute("aria-current"),
  ).toBe("page");
  // The drawer's head walks to another stage in place.
  await act(async () => {
    host
      .querySelector<HTMLElement>("[data-line-drawer-stage='grouping']")!
      .click();
  });
  expect(navigationLog.at(-1)).toEqual({
    action: "replace",
    path: "/flows?project=pr-1&view=signals&graph=line&stage=grouping",
  });
  await key("Escape");
  expect(navigationLog.at(-1)).toEqual({
    action: "push",
    path: "/flows?project=pr-1&view=signals&graph=line",
  });
  await close();
}, 30_000);
