import { expect, test } from "bun:test";
import { api } from "@codecast/convex/convex/_generated/api";
import { mountWeb } from "../test-helpers/mountWeb";
import { pending } from "../test-helpers/testConvex";
import { useRunWorkflow } from "./useSyncWorkflows";

const RUN = { _id: "r1", workflow_id: "wf1", graph_version_id: "v1" };
const ROW = {
  _id: "wf1",
  name: "change",
  slug: "change",
  nodes: [{ id: "fix" }],
  edges: [],
};
const PINNED = {
  _id: "v1",
  workflow_id: "wf1",
  name: "change",
  slug: "change",
  nodes: [{ id: "decide__decide" }],
  edges: [],
};
const refusal = new Error(
  "Could not find public function for 'workflow_runs:pinnedGraphOfRun'",
);

function Probe() {
  const workflow = useRunWorkflow(RUN);
  return (
    <output>
      {workflow === undefined ? "loading" : JSON.stringify(workflow)}
    </output>
  );
}

async function mount({
  pinned = false,
  reply = pending,
}: {
  pinned?: boolean;
  reply?: typeof pending | Error;
} = {}) {
  const { backend, container } = await mountWeb(<Probe />, {
    setup: (backend, store) => {
      store.syncTable("workflows", [ROW]);
      if (pinned) store.syncTable("runGraphs", [PINNED]);
      backend.set(api.workflow_runs.pinnedGraphOfRun, reply);
      backend.set(api.workflow_runs.graphOfRun, pending);
    },
  });
  expect(backend.queryRequests).toContainEqual({
    name: "workflow_runs:pinnedGraphOfRun",
    args: { run_id: RUN._id },
  });
  return container.querySelector("output");
}

test("the pinned graph, keyed back to its row", async () => {
  const output = await mount({ pinned: true });
  expect(JSON.parse(output?.textContent ?? "")).toMatchObject({
    _id: "wf1",
    version_id: "v1",
    nodes: [{ id: "decide__decide" }],
  });
});

test("still loading while the pinned-graph query has not answered", async () => {
  const output = await mount();
  expect(output?.textContent).toBe("loading");
});

test("a backend without the pinned-graph query draws the row instead of loading forever", async () => {
  const output = await mount({ reply: refusal });
  expect(JSON.parse(output?.textContent ?? "")).toMatchObject({
    _id: "wf1",
    nodes: [{ id: "fix" }],
  });
});
