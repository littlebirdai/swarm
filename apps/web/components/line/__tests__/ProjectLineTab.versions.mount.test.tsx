import { expect, test } from "bun:test";
import { useInboxStore } from "../../../store/inboxStore";
import { mountWeb } from "../../../test-helpers/mountWeb";
import { holdLineWorkspaceFeeds } from "../../../test-helpers/lineWorkspaceBackend";
import { ProjectLineTab } from "../ProjectLineTab";

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
  started_at: now - 9 * DAY + i,
  completed_at: now - 9 * DAY + i + 1,
});
const nodesV1 = [
  { id: "prove", h: "aaaa1111" },
  { id: "review", h: "bbbb2222" },
];
const nodesV2 = [
  { id: "prove", h: "cccc3333" },
  { id: "review", h: "bbbb2222" },
];
const line = (
  id: string,
  at: number,
  hash: string,
  nodes: typeof nodesV1,
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
  graph_hash: hash,
  graph_nodes: nodes,
  node_statuses: [n("start", 0), ...statuses],
  created_at: at,
  updated_at: at + 1000,
});

test("versions say what changed and account for every run, stopped ones included", async () => {
  const { container: host, close } = await mountWeb(
    <ProjectLineTab projectId="p1" />,
    {
      path: "/projects/p1?tab=line",
      authenticated: true,
      setup(backend, store) {
        window.innerWidth = 1400;
        store.syncTable("currentUser", { _id: ME, name: "Me" });
        useInboxStore.setState({ clientStateInitialized: true });
        store.syncTable("projects", [project]);
        store.syncTable("tasks", [
          {
            _id: "t1",
            short_id: "ct-1",
            title: "cause",
            status: "done",
            workspace: WS,
            project_id: "p1",
            created_at: now - 10 * DAY,
            updated_at: now,
            cause: {
              signal_count: 1,
              first_seen: now - 10 * DAY,
              last_seen: now - DAY,
            },
          },
        ]);
        store.syncTable("workflowRuns", [
          line(
            "a",
            now - 8 * DAY,
            "1111111111111111",
            nodesV1,
            [n("ground", 1), n("prove", 2, "failed")],
            "failed",
          ),
          line("b", now - 7 * DAY, "1111111111111111", nodesV1, [
            n("ground", 1),
            n("decide", 2),
            n("drop", 3),
          ]),
          line("c", now - 2 * DAY, "2222222222222222", nodesV2, [
            n("ground", 1),
            n("decide", 2),
            n("ship", 3),
            n("watch", 4),
          ]),
          {
            ...line("decoy", now, "3333333333333333", nodesV2, [n("ship", 1)]),
            project_id: "outside",
            workspace: "user:another",
          },
        ]);
        holdLineWorkspaceFeeds(backend);
      },
    },
  );
  const rows = Object.fromEntries(
    [...host.querySelectorAll<HTMLElement>("[data-line-version]")].map((r) => [
      r.dataset.lineVersion,
      [...r.querySelectorAll("td")].map((td) => td.textContent?.trim()),
    ]),
  );
  expect(Object.keys(rows)).toEqual(["2222222222222222", "1111111111111111"]);
  expect(rows["2222222222222222"][0]).toBe("Prove editedlatest");
  expect(rows["1111111111111111"][0]).toBe("First recorded version");
  // The hash is data, not a label: it is the change's tooltip.
  expect(
    host
      .querySelector('[data-line-version="2222222222222222"] td span[title]')
      ?.getAttribute("title"),
  ).toBe("Graph 2222222222222222");
  // Runs, Shipped, Revised, Dropped, Stopped: 2 runs = 1 dropped + 1 stopped.
  expect(rows["1111111111111111"].slice(2, 7)).toEqual([
    "2",
    "0 0%",
    "0 0%",
    "1",
    "1",
  ]);
  expect(
    host.querySelector("[data-line-versions] thead")?.textContent,
  ).toContain("Stopped");
  await close();
}, 30_000);
