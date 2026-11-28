import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseWorkflowSource } from "./parser";
import { BUILTIN_WORKFLOW_TEMPLATES } from "./templates";

export type Station =
  | "ground"
  | "plan"
  | "analyze"
  | "prove"
  | "implement"
  | "review"
  | "card_write";

export const STATION_OF: Array<[RegExp, Station]> = [
  [/^You ground one cause/m, "ground"],
  [/^You write the plan/m, "plan"],
  [/acceptance criteria an independent reviewer/, "analyze"],
  [/^You show the miss/m, "prove"],
  [/Implement task/, "implement"],
  [/You are the independent reviewer/, "review"],
  [/^# Presenting a decision/m, "card_write"],
];

export const offlineLine = (dir: string) => {
  const graph = parseWorkflowSource(BUILTIN_WORKFLOW_TEMPLATES.line);
  const stub = (id: string, script: string) => {
    graph.nodes.get(id)!.script = script;
  };
  stub("red", `echo '{"red": true, "dir": "${dir}"}'`);
  stub("green", "true");
  stub("eval", "true");
  stub("card_draft", `echo '{"card": {"wrong": ""}}'`);
  for (const id of [
    "card",
    "ship",
    "watch",
    "park",
    "dissolve",
    "unproven",
    "reopen",
    "drop",
  ])
    stub(id, "true");
  graph.nodes.get("verify")!.script = "true";
  return graph;
};

export function createOfflineLineFixture() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "line-"));
  const origFetch = globalThis.fetch;
  const origLog = console.log;
  console.log = () => {};
  const calls: Array<{ route: string; body: any }> = [];
  let spawnCount = 0;
  const stationOf: Record<string, Station> = {};
  const gateAnswers: string[] = [];
  const pinnedStatus: Partial<Record<Station, string>> = {};
  const grounded = {
    readiness: "ready",
    goal_ref: "in-3:activation",
    category: "code",
    risk: "low",
  };
  let task: any = {
    short_id: "ct-7",
    title: "Add the thing",
    status: "open",
    steps: [],
    assignee: "infra-lead",
  };
  const pinned: Partial<Record<Station, string>> = {
    prove: 'Showed it failing.\n```json\n{"reproduced": true}\n```',
    card_write:
      'Posted sd-1.\n```json\n{"question": "Should the thing be added?", "recommend": "ship", "why": "Y.", "page": "/r/present/page.html"}\n```',
  };
  const effects: Partial<Record<Station, () => void>> = {
    ground: () => {
      task = { ...task, ...grounded };
    },
    analyze: () => {
      task = { ...task, steps: [{ title: "A works" }, { title: "B works" }] };
    },
    implement: () => {
      task = { ...task, status: "in_review", execution_status: "done" };
    },
    review: () => {
      task = {
        ...task,
        status: "done",
        review_verdict: { verdict: "approve", at: Date.now() + 1 },
      };
    },
  };

  globalThis.fetch = (async (url: any, init: any) => {
    const route = String(url).replace(/^https?:\/\/[^/]+/, "");
    const body = JSON.parse(init?.body || "{}");
    calls.push({ route, body });
    let out: any = {};
    if (route === "/cli/work/get") out = task;
    else if (route === "/cli/spawn") {
      spawnCount++;
      const id = `conv_${spawnCount}`;
      stationOf[id] =
        STATION_OF.find(([re]) => re.test(body.prompt))?.[1] ??
        ("unknown" as Station);
      out = { conversation_id: id, short_id: `s${spawnCount}` };
    } else if (route === "/cli/inbox") {
      const id = body.session_ids[0];
      effects[stationOf[id]]?.();
      out = { sessions: [{ id, work_state: "done", is_live: false }] };
    } else if (route === "/cli/sessions/state/get") {
      out = {
        ok: true,
        status: pinnedStatus[stationOf[body.session]] ?? "done",
        state: pinned[stationOf[body.session]] ?? null,
        at: calls.length,
      };
    } else if (route === "/cli/workflow-runs/poll-gate") {
      out = { status: "paused", gate_response: gateAnswers.shift() ?? null };
    } else if (
      route === "/cli/work/update" ||
      route === "/cli/workflow-runs/task-transition" ||
      route === "/cli/work/comment" ||
      route === "/cli/decide"
    ) {
      if (
        (route === "/cli/work/update" ||
          route === "/cli/workflow-runs/task-transition") &&
        body.status
      )
        task = { ...task, status: body.status };
      out = { success: true, id: "sd-1" };
    }
    return new Response(JSON.stringify(out), { status: 200 });
  }) as typeof fetch;

  const opts = (extra: Record<string, any> = {}) => ({
    cwd: tmpDir,
    taskId: "ct-7",
    apiToken: "tok",
    convexSiteUrl: "https://convex.test",
    pollIntervalMs: 1,
    ...extra,
  });
  const spawns = () =>
    calls
      .filter((c) => c.route === "/cli/spawn")
      .map((c, i) => ({ station: stationOf[`conv_${i + 1}`], ...c.body }));
  const stations = () => spawns().map((s) => s.station);

  return {
    tmpDir,
    calls,
    grounded,
    pinned,
    pinnedStatus,
    gateAnswers,
    effects,
    stationOf,
    getTask: () => task,
    setTask: (next: any) => {
      task = next;
    },
    opts,
    spawns,
    stations,
    restore: () => {
      globalThis.fetch = origFetch;
      console.log = origLog;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}
