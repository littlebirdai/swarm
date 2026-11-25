import { beforeEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { LineTask } from "../../lib/taskLine";
import type { TaskItem } from "../../store/inboxStore";
import { webBuilders } from "../../test-helpers/builders";
import { mountWeb } from "../../test-helpers/mountWeb";
import { pending } from "../../test-helpers/testConvex";
import { StationStrip, TaskLineChip } from "../tasks/StationStrip";

const TASK_ID = "k97abcdefabcdefabcdefabcdefabcde";
const RUN_ID = "kw1abcdefabcdefabcdefabcdefabcde";
const DEC_ID = "kd1abcdefabcdefabcdefabcdefabcde";
const CONV_ID = "kc1abcdefabcdefabcdefabcdefabcde";
const WF_ID = "kf1abcdefabcdefabcdefabcdefabcde";

const builder = webBuilders("stationStrip.mount.test.tsx");
type StationTask = TaskItem & Pick<LineTask, "review_verdict">;
const task = (over: Partial<StationTask> = {}): StationTask => ({
  ...builder.task.build({
    _id: TASK_ID,
    short_id: "ct-1",
    title: "Ship the strip",
    status: "in_review",
    source: "agent",
  }),
  ...over,
});

const decision = {
  _id: DEC_ID,
  short_id: "sd-211",
  conversation_id: CONV_ID,
  session_id: "s1",
  question: "Merge as is?",
  options: [{ label: "Yes" }, { label: "No" }],
  blocking: true,
  status: "pending",
  task_id: TASK_ID,
  station: "in_review",
  created_at: 5,
};

const run = {
  _id: RUN_ID,
  status: "running",
  task_id: TASK_ID,
  current_node_id: "review",
  workflow_name: "line",
  updated_at: 50,
  node_statuses: [
    {
      node_id: "implement",
      status: "completed",
      started_at: 1,
      completed_at: 10,
    },
    {
      node_id: "review",
      status: "running",
      started_at: 20,
      label: "Review",
      session_id: "sess-r",
      session: { _id: CONV_ID, title: "Review ct-1", is_active: true },
    },
  ],
};

type Seed = {
  sessionDecisions?: Record<string, typeof decision>;
  workflowRuns?: Record<string, { _id: string; workflow_name?: string }>;
  workflows?: Record<
    string,
    {
      _id: string;
      name: string;
      slug?: string;
      nodes: { id: string; label: string }[];
    }
  >;
  projects?: Record<
    string,
    { _id: string; short_id: string; title: string; workspace: string }
  >;
  currentUser?: { _id: string };
};
let seed: Seed;

beforeEach(() => {
  seed = {};
});

const mount = (element: ReactElement) =>
  mountWeb(element, {
    path: "/tasks",
    setup: (backend, store) => {
      window.innerWidth = 390;
      store.syncTable(
        "sessionDecisions",
        Object.values(seed.sessionDecisions ?? {}),
      );
      store.syncTable("workflowRuns", Object.values(seed.workflowRuns ?? {}));
      store.syncTable("workflows", Object.values(seed.workflows ?? {}));
      store.syncTable("projects", Object.values(seed.projects ?? {}));
      if (seed.currentUser) store.syncTable("currentUser", seed.currentUser);
      backend.set(api.workflow_runs.get, pending);
      backend.set(api.workflow_runs.graphOfRun, pending);
    },
  });

describe("StationStrip", () => {
  test("draws the default stations in order and highlights the current one", async () => {
    const { container, close } = await mount(<StationStrip task={task()} />);
    const ids = [...container.querySelectorAll("[data-station]")].map((el) =>
      el.getAttribute("data-station"),
    );
    expect(ids).toEqual([
      "backlog",
      "open",
      "in_progress",
      "in_review",
      "done",
      "dropped",
    ]);
    expect(
      container.querySelector("[data-current]")?.getAttribute("data-station"),
    ).toBe("in_review");
    expect(
      container
        .querySelector("[data-station-strip]")
        ?.getAttribute("data-station-strip"),
    ).toBe("in_review");
    // Nothing runs and nothing holds: no detail row, no marker.
    expect(container.querySelector("[data-held-by]")).toBeNull();
    expect(container.querySelector("[data-station-detail]")).toBeNull();
    await close();
  });

  test("a held task carries the marker on its current station, linking the decision", async () => {
    seed = { sessionDecisions: { [DEC_ID]: decision } };
    const { container, close, navigationLog } = await mount(
      <StationStrip task={task()} />,
    );
    const marker = container.querySelector(
      "[data-held-by]",
    ) as HTMLAnchorElement;
    expect(marker).not.toBeNull();
    expect(marker.getAttribute("data-held-by")).toBe("sd-211");
    expect(marker.getAttribute("href")).toBe("/decisions/sd-211");
    expect(marker.closest("[data-station]")?.getAttribute("data-station")).toBe(
      "in_review",
    );
    await close();
  });

  test("a decision bound at another station does not hold", async () => {
    seed = {
      sessionDecisions: { [DEC_ID]: { ...decision, station: "in_progress" } },
    };
    const { container, close } = await mount(<StationStrip task={task()} />);
    expect(container.querySelector("[data-held-by]")).toBeNull();
    await close();
  });

  test("a live run shows its node, the hand and the elapsed time under the current station", async () => {
    seed = { workflowRuns: { [RUN_ID]: run } };
    const { container, close } = await mount(
      <StationStrip task={task({ workflow_run_id: RUN_ID })} />,
    );
    const detail = container.querySelector(
      "[data-station-detail]",
    ) as HTMLElement;
    expect(detail).not.toBeNull();
    expect(
      detail.querySelector("[data-live-node]")?.getAttribute("data-live-node"),
    ).toBe("review");
    expect(detail.textContent).toContain("Review");
    const hand = detail.querySelector("[data-hand-state]") as HTMLAnchorElement;
    expect(hand.getAttribute("href")).toBe(`/conversation/${CONV_ID}`);
    expect(hand.textContent).toContain("Review ct-1");
    // The run's own flag says the hand is active; the store holds no row.
    expect(hand.getAttribute("data-hand-state")).toBe("working");
    // Started at t=20ms, so the elapsed reads in days by now.
    expect(detail.textContent).toMatch(/\d+d \d+h/);
    await close();
  });

  test("names the live node by the workflow's label when the run row carries only ids", async () => {
    // workflow_runs.get returns the raw row: no current_node_label, no label
    // on node_statuses. The label comes from the workflow in the store.
    const rawRun = {
      _id: RUN_ID,
      status: "running",
      task_id: TASK_ID,
      workflow_id: WF_ID,
      current_node_id: "review",
      updated_at: 50,
      node_statuses: [{ node_id: "review", status: "running", started_at: 20 }],
    };
    const workflow = {
      _id: WF_ID,
      name: "line",
      nodes: [
        { id: "implement", label: "Implement" },
        { id: "review", label: "Review the change" },
      ],
    };
    seed = {
      workflowRuns: { [RUN_ID]: rawRun },
      workflows: { [WF_ID]: workflow },
    };
    const { container, close } = await mount(
      <StationStrip task={task({ workflow_run_id: RUN_ID })} />,
    );
    const node = container.querySelector("[data-live-node]") as HTMLElement;
    expect(node.getAttribute("data-live-node")).toBe("review");
    expect(node.textContent).toContain("Review the change");
    expect(node.textContent).not.toMatch(/\breview\b/);
    await close();
  });

  test("a line run's node links to that station in line settings; a customized line says so", async () => {
    // Shipped line: the node names the task's project.
    seed = { workflowRuns: { [RUN_ID]: run } };
    let m = await mount(
      <StationStrip
        task={task({ workflow_run_id: RUN_ID, project_id: "p1" })}
      />,
    );
    let link = m.container.querySelector(
      "a[data-station-settings]",
    ) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(
      "/flows/settings?project=p1&section=stations&station=review",
    );
    expect(m.container.querySelector("[data-line-customized]")).toBeNull();
    await m.close();

    // The project's customized copy: the link names the project it forks for, with the chip.
    const forkRun = {
      ...run,
      workflow_id: WF_ID,
      workflow_name: "Steps for Codecast",
    };
    seed = {
      workflowRuns: { [RUN_ID]: forkRun },
      workflows: {
        [WF_ID]: {
          _id: WF_ID,
          slug: "line-pr-1",
          name: "Steps for Codecast",
          nodes: [{ id: "review", label: "Review" }],
        },
      },
      projects: {
        p1: {
          _id: "p1",
          short_id: "pr-1",
          title: "Codecast",
          workspace: "user:u1",
        },
      },
      currentUser: { _id: "u1" },
    };
    m = await mount(<StationStrip task={task({ workflow_run_id: RUN_ID })} />);
    link = m.container.querySelector(
      "a[data-station-settings]",
    ) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(
      "/flows/settings?project=pr-1&section=stations&station=review",
    );
    expect(
      m.container.querySelector("[data-line-customized]")?.textContent,
    ).toBe("customized");
    await m.close();

    // Any other workflow: the node stays plain text.
    seed = {
      workflowRuns: { [RUN_ID]: { ...run, workflow_name: "release" } },
      workflows: {},
    };
    m = await mount(<StationStrip task={task({ workflow_run_id: RUN_ID })} />);
    expect(m.container.querySelector("[data-live-node]")).not.toBeNull();
    expect(m.container.querySelector("a[data-station-settings]")).toBeNull();
    await m.close();
  });

  test("a review verdict renders as a chip even with no run", async () => {
    const { container, close } = await mount(
      <StationStrip
        task={task({
          review_verdict: { verdict: "changes", at: 1, note: "tests" },
        })}
      />,
    );
    expect(
      container
        .querySelector("[data-review-verdict]")
        ?.getAttribute("data-review-verdict"),
    ).toBe("changes");
    await close();
  });
});

describe("TaskLineChip", () => {
  test("says held at the station when a blocking decision holds the task", async () => {
    seed = {
      sessionDecisions: { [DEC_ID]: decision },
      workflowRuns: { [RUN_ID]: run },
    };
    const { container, close } = await mount(
      <TaskLineChip task={task({ workflow_run_id: RUN_ID })} />,
    );
    const chip = container.querySelector(
      "[data-task-line-chip]",
    ) as HTMLElement;
    expect(chip.getAttribute("data-task-line-chip")).toBe("held");
    expect(chip.textContent).toContain("held at In Review");
    await close();
  });

  test("names the station and the node for a live run, and nothing otherwise", async () => {
    seed = { workflowRuns: { [RUN_ID]: run } };
    const live = await mount(
      <TaskLineChip task={task({ workflow_run_id: RUN_ID })} />,
    );
    expect(
      live.container.querySelector("[data-task-line-chip]")?.textContent,
    ).toContain("at In Review · Review");
    await live.close();
    // A live run bound to the task by task_id counts even when the task does
    // not name it, so the idle case needs an empty runs collection.
    seed = { workflowRuns: {} };
    const idle = await mount(<TaskLineChip task={task()} />);
    expect(idle.container.querySelector("[data-task-line-chip]")).toBeNull();
    await idle.close();
  });
});
