import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { buildBootGraph, staticImportSpecifiers } from "./bench/bootGraph.js";

test("the supervisor is absent from the CLI startup graph and loads once after the hook server starts", async () => {
  const daemonPath = new URL("./daemon.ts", import.meta.url);
  const daemon = await Bun.file(daemonPath).text();
  const load = 'import("@codecast/edge-supervisor").then(';
  expect(daemon.split(load)).toHaveLength(2);
  expect(daemon.indexOf(load)).toBeGreaterThan(
    daemon.indexOf("hookServer = startHookServer("),
  );
  expect(
    staticImportSpecifiers(daemon).filter((specifier) =>
      /@codecast\/edge-(?:client|contract|supervisor)/.test(specifier),
    ),
  ).toEqual([]);
  const graph = buildBootGraph(
    fileURLToPath(new URL("./index.ts", import.meta.url)),
  );
  expect(
    [...graph.nodes.keys()].some((path) =>
      path.includes("/packages/edge-supervisor/"),
    ),
  ).toBe(false);
}, 20_000);
