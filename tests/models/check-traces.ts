import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRuleSections } from "./config-rules";
import { modelOnlyActions, type ModelState, traceCases } from "./trace-cases";
import { parseTlcResult } from "./tlc-result";

type Edge = { action: string; target: string };

function parseState(label: string): ModelState {
  return Object.fromEntries(
    label
      .split("\n")
      .map((line) => {
        const match = /^\/\\ (\w+) = (.+)$/.exec(line);
        if (!match) throw new Error(`Unexpected TLC state field: ${line}`);
        const [, key, value] = match;
        if (key === "mine") {
          const workers = /^\[w1 \|-> (\d+), w2 \|-> (\d+)\]$/.exec(value);
          if (!workers) throw new Error(`Unexpected Lease workers: ${value}`);
          return ["mine", { w1: Number(workers[1]), w2: Number(workers[2]) }];
        }
        return [
          key,
          JSON.parse(
            value === "TRUE" || value === "FALSE" ? value.toLowerCase() : value,
          ),
        ];
      })
      .toSorted(([left], [right]) => String(left).localeCompare(String(right))),
  );
}

function readGraph(dot: string) {
  const states = new Map<string, ModelState>();
  const edges = new Map<string, Edge[]>();
  const initial: string[] = [];
  for (const line of dot.split("\n")) {
    const node =
      /^(-?\d+) \[label=("(?:[^"\\]|\\.)*")(,style = filled)?\]/.exec(line);
    const edge = /^(-?\d+) -> (-?\d+) \[label="(\w+)"/.exec(line);
    if (node) {
      states.set(node[1], parseState(JSON.parse(node[2])));
      if (node[3]) initial.push(node[1]);
    } else if (edge) {
      const [, source, target, action] = edge;
      const outgoing = edges.get(source) ?? [];
      outgoing.push({ target, action });
      edges.set(source, outgoing);
    } else if (/^-?\d/.test(line)) {
      throw new Error(`Unexpected TLC graph line: ${line}`);
    }
  }
  if (initial.length !== 1 || edges.size === 0) {
    throw new Error("Expected one initial state and a nonempty graph");
  }
  return { initial: initial[0], states, edges };
}

function tracePath(
  graph: ReturnType<typeof readGraph>,
  name: string,
  actions: string[],
  end: ModelState,
) {
  function follow(source: string, index: number): Edge[] | undefined {
    const state = graph.states.get(source);
    if (!state) throw new Error(`Missing state ${source}`);
    if (index === actions.length) {
      return Object.entries(end).every(([key, value]) => state[key] === value)
        ? []
        : undefined;
    }
    const choices = (graph.edges.get(source) ?? [])
      .filter(({ action }) => action === actions[index])
      .sort((left, right) => {
        const a = JSON.stringify(graph.states.get(left.target));
        const b = JSON.stringify(graph.states.get(right.target));
        if (a === b) return 0;
        return a < b ? -1 : 1;
      });
    for (const edge of choices) {
      const suffix = follow(edge.target, index + 1);
      if (suffix) return [edge, ...suffix];
    }
  }
  const path = follow(graph.initial, 0);
  if (!path)
    throw new Error(
      `${name}: no TLC behavior for ${actions.join(" → ")} with final fields ${JSON.stringify(end)}`,
    );
  return {
    initial: graph.states.get(graph.initial),
    steps: path.map(({ action, target }) => ({
      action,
      state: graph.states.get(target),
    })),
  };
}

async function dumpGraph(
  java: string,
  jar: string,
  model: string,
  configName: string,
) {
  const dir = await mkdtemp(join(tmpdir(), "swarm-trace-"));
  try {
    const config = await Bun.file(
      join(import.meta.dir, `${configName}.cfg`),
    ).text();
    const dump = join(dir, "graph.dot");
    const configPath = join(dir, "trace.cfg");
    let checks = config;
    for (const { start, end } of parseRuleSections(config).toReversed()) {
      checks = checks.slice(0, start) + checks.slice(end);
    }
    await Bun.write(configPath, checks);
    const proc = Bun.spawn(
      [
        java,
        "-Xmx128m",
        "-XX:+UseParallelGC",
        "-cp",
        jar,
        "tlc2.TLC",
        "-workers",
        "1",
        "-seed",
        "1",
        "-fp",
        "0",
        "-metadir",
        dir,
        "-dump",
        "dot,actionlabels",
        dump,
        "-config",
        configPath,
        model,
      ],
      { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe", timeout: 30_000 },
    );
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if (parseTlcResult(code, stdout + stderr, []).outcome !== "holds") {
      throw new Error(`TLC could not dump ${configName}\n${stdout}\n${stderr}`);
    }
    return readGraph(await Bun.file(dump).text());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function checkTraces(java: string, jar: string, update: boolean) {
  for (const model of Object.keys(traceCases) as (keyof typeof traceCases)[]) {
    const cases = traceCases[model];
    const source = await Bun.file(join(import.meta.dir, `${model}.tla`)).text();
    const next = /^Next ==\s+([\s\S]+?)^\s*\n\s*Spec ==/m.exec(source)?.[1];
    const [prefix, ...disjunctions] =
      next
        ?.trim()
        .replaceAll(/\\E \w+ \\in \w+ : /g, "")
        .split(/\s*\\\/\s*/) ?? [];
    if (
      prefix !== "" ||
      !disjunctions.length ||
      disjunctions.some((term) => !/^\w+(?:\(\w+\))?$/.test(term.trim()))
    ) {
      throw new Error(`${model}: expected Next to list named actions`);
    }
    const actions = disjunctions
      .map((term) => term.trim().split("(")[0])
      .sort();
    const covered = [
      ...new Set(cases.flatMap(([, , sequence]) => sequence.split(" "))),
    ].sort();
    if (JSON.stringify(actions) !== JSON.stringify(covered)) {
      throw new Error(
        `${model}: Next has [${actions}], traces cover [${covered}]`,
      );
    }
    const modelOnly = new Set(modelOnlyActions[model]);
    for (const action of modelOnly) {
      if (!covered.includes(action)) {
        throw new Error(`${model}: unknown model-only action ${action}`);
      }
    }
    const codeActions = covered.filter((action) => !modelOnly.has(action));
    const graphs = new Map<string, Awaited<ReturnType<typeof dumpGraph>>>();
    const path = join(
      import.meta.dir,
      "fixtures",
      `${model.toLowerCase()}-traces.json`,
    );
    const file = Bun.file(path);
    const committed = update ? {} : await file.json();
    const traces: Record<string, unknown> = {};
    for (const [name, config, sequence, end] of cases) {
      const graph =
        graphs.get(config) ?? (await dumpGraph(java, jar, model, config));
      graphs.set(config, graph);
      const trace = tracePath(
        graph,
        `${model}/${name}`,
        sequence.split(" "),
        end ?? {},
      );
      if (
        !update &&
        JSON.stringify(trace) !== JSON.stringify(committed[name])
      ) {
        throw new Error(`${model}/${name}: trace differs from TLC`);
      }
      traces[name] = trace;
    }
    if (update) await Bun.write(path, JSON.stringify(traces, null, 2) + "\n");
    else if (JSON.stringify(traces) !== JSON.stringify(committed)) {
      throw new Error(`${model}: unexpected committed trace names`);
    }
    console.log(
      `${model}: ${cases.length} replay traces cover ${covered.length}/${actions.length} model actions, ${codeActions.length}/${actions.length} actions drive code`,
    );
  }
}
