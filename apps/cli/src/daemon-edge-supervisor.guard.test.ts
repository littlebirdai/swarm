import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { buildBootGraph, staticImportSpecifiers } from "./bench/bootGraph.js";

test("the supervisor is absent from the CLI startup graph and loads only after opt-in", async () => {
  const daemonPath = new URL("./daemon.ts", import.meta.url);
  const daemon = await Bun.file(daemonPath).text();
  const load = 'import("@codecast/edge-supervisor").then(';
  const optedIn = daemon.match(
    /^  if \(process\.env\.CODECAST_EDGE_SUPERVISOR_V1 === "1"\) \{([^]*?)^  \}/m,
  );
  expect(optedIn).not.toBeNull();
  expect(optedIn?.[1]).toContain(load);
  expect(daemon.split(load)).toHaveLength(2);
  expect(optedIn?.index).toBeGreaterThan(
    daemon.indexOf("hookServer = startHookServer("),
  );
  expect(staticImportSpecifiers(daemon)).not.toContain(
    "@codecast/edge-supervisor",
  );
  const graph = buildBootGraph(
    fileURLToPath(new URL("./index.ts", import.meta.url)),
  );
  expect(
    [...graph.nodes.keys()].some((path) =>
      path.includes("/packages/edge-supervisor/"),
    ),
  ).toBe(false);
}, 20_000);
