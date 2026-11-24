import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DAEMON_BUILD_ID } from "./daemonBuildId.js";
import { computeDaemonBuildId } from "./daemonBuildIdCompute.js";

test("the stamped build id has the generated shape", () => {
  expect(DAEMON_BUILD_ID).toMatch(/^[0-9a-f]{12}$/);
});

test("the daemon closure follows a workspace library export", () => {
  const root = mkdtempSync(join(tmpdir(), "daemon-workspace-"));
  try {
    const cli = join(root, "apps", "cli", "src");
    const lib = join(root, "packages", "new-library");
    mkdirSync(cli, { recursive: true });
    mkdirSync(join(lib, "src"), { recursive: true });
    writeFileSync(join(cli, "daemon.ts"), 'import "@codecast/example/tool";');
    const manifest = join(lib, "package.json");
    writeFileSync(
      manifest,
      JSON.stringify({
        name: "@codecast/example",
        exports: { "./tool": "./src/tool.ts" },
      }),
    );
    writeFileSync(join(lib, "src", "tool.ts"), "export const tool = 1;");
    writeFileSync(join(lib, "src", "other.ts"), "export const tool = 1;");
    const before = computeDaemonBuildId(root);
    expect(before.files).toEqual([
      "apps/cli/src/daemon.ts",
      "packages/new-library/src/tool.ts",
    ]);

    writeFileSync(
      manifest,
      JSON.stringify({
        name: "@codecast/example",
        exports: { "./tool": "./src/other.ts" },
      }),
    );
    const after = computeDaemonBuildId(root);
    expect(after.files).toEqual([
      "apps/cli/src/daemon.ts",
      "packages/new-library/src/other.ts",
    ]);
    expect(after.id).not.toBe(before.id);
  } finally {
    rmSync(root, { recursive: true });
  }
});

// Walking the whole closure reads a few hundred files, which is fine in CI and
// noise in a local loop. CI sets DAEMON_BUILD_ID_CHECK=1, so a commit that
// changed daemon code without re-stamping fails there.
//
// The explicit timeout is the point of the third argument: a loaded machine has
// taken this past bun's 5s default, and the cli suite runs with --bail, so one
// slow read would fail the whole job on code nobody touched.
test.skipIf(!process.env.DAEMON_BUILD_ID_CHECK)(
  "the stamp matches the current daemon closure",
  () => {
    const { id, files } = computeDaemonBuildId();
    expect(
      id,
      `The daemon build id is stale: the stamp says ${DAEMON_BUILD_ID}, the closure (${files.length} files) ` +
        `hashes to ${id}. Run: cd apps/cli && bun scripts/stamp-daemon-build-id.ts, then commit src/daemonBuildId.ts.`,
    ).toBe(DAEMON_BUILD_ID);
  },
  60_000,
);
