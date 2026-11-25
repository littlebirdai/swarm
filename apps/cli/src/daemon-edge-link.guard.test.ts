import { expect, test } from "bun:test";

test("the daemon only imports the edge link inside the explicit opt-in branch", async () => {
  const daemon = await Bun.file(new URL("./daemon.ts", import.meta.url)).text();
  const linkImport = /import\("\.\/daemon-edge-link\.js"\)/g;
  const enabledBranch = daemon.match(
    /^    if \(process\.env\.CODECAST_EDGE_V1 === "1"\) \{([^]*?)^    \}/m,
  )?.[1];

  expect(daemon.match(linkImport)).toHaveLength(1);
  expect(enabledBranch?.match(linkImport)).toHaveLength(1);
});
