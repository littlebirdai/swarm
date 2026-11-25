import { describe, expect, test } from "bun:test";
import { act } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { mountWeb } from "../../test-helpers/mountWeb";
import { pending } from "../../test-helpers/testConvex";
import { WorkflowContextPanel } from "../WorkflowContextPanel";
import { TooltipProvider } from "../ui/tooltip";

const RUN_ID = "kw1abcdefabcdefabcdefabcdefabcde" as Id<"workflow_runs">;
const WF_ID = "kf1abcdefabcdefabcdefabcdefabcde";

const run = {
  _id: RUN_ID,
  workflow_id: WF_ID,
  workflow_name: "cloud-seamless-land",
  status: "running",
  current_node_id: "polish",
  node_statuses: [
    { node_id: "squash-rebase", status: "completed", label: "squash-rebase" },
    {
      node_id: "closeout-mirror",
      status: "completed",
      label: "closeout-mirror",
    },
    { node_id: "polish", status: "pending", label: "polish" },
  ],
};

const workflow = {
  _id: WF_ID,
  name: "cloud-seamless-land",
  nodes: [
    { id: "squash-rebase", label: "squash-rebase" },
    { id: "closeout-mirror", label: "closeout-mirror" },
    { id: "polish", label: "polish" },
  ],
};

const mount = () =>
  mountWeb(
    <TooltipProvider>
      <WorkflowContextPanel workflowRunId={RUN_ID} />
    </TooltipProvider>,
    {
      setup: (backend, store) => {
        store.syncTable("workflowRuns", [
          run,
          { ...run, _id: "unrelated", workflow_name: "Other run" },
        ]);
        store.syncTable("workflows", [workflow]);
        backend.set(api.workflow_runs.get, pending);
        backend.set(api.workflow_runs.graphOfRun, pending);
      },
    },
  );

describe("WorkflowContextPanel", () => {
  test("starts collapsed: name and status, no node list", async () => {
    const { container } = await mount();
    expect(container.textContent).toContain("cloud-seamless-land");
    expect(container.textContent).toContain("running");
    expect(container.textContent).toContain("2/3");
    expect(
      container.querySelector("button")?.getAttribute("aria-expanded"),
    ).toBe("false");
    expect(container.textContent).not.toContain("squash-rebase");
    expect(container.textContent).not.toContain("Open the run");
    expect(container.textContent).toContain("polish");
  });

  test("a click on the header reveals the nodes", async () => {
    const { container, navigationLog } = await mount();
    await act(() => {
      container.querySelector("button")!.click();
    });
    expect(
      container.querySelector("button")?.getAttribute("aria-expanded"),
    ).toBe("true");
    expect(container.textContent).toContain("squash-rebase");
    expect(container.textContent).toContain("polish");
    expect(container.textContent).toContain("Open the run");
    const link = container.querySelector<HTMLAnchorElement>(
      `a[href="/workflows/runs/${RUN_ID}"]`,
    );
    expect(link).not.toBeNull();
    await act(() => link!.click());
    expect(navigationLog.at(-1)).toEqual({
      action: "push",
      path: `/workflows/runs/${RUN_ID}`,
    });
  });
});
