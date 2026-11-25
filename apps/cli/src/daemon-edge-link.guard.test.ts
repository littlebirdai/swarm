import { expect, test } from "bun:test";
import { staticImportSpecifiers } from "./bench/bootGraph";

test("the daemon only imports the edge link inside the explicit opt-in branch", async () => {
  const daemon = await Bun.file(new URL("./daemon.ts", import.meta.url)).text();
  const enabledBranch = daemon.match(
    /^    if \(process\.env\.CODECAST_EDGE_V1 === "1"\) \{([^]*?)^    \}/m,
  )?.[1];

  expect(enabledBranch).toBeDefined();
  expect(
    enabledBranch?.includes(
      'void (edgeLink ??= import("./daemon-edge-link.js"))',
    ),
  ).toBe(true);
  expect(
    staticImportSpecifiers(daemon).filter((specifier) =>
      /(?:daemon-edge-link|@codecast\/edge-(?:client|contract))/.test(
        specifier,
      ),
    ),
  ).toEqual([]);
});
