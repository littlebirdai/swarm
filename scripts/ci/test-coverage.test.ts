import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { testCoverage } from "./test-coverage";

const ALLOWED_UNREACHED: Record<string, string> = {
  "apps/cli/learning/bunToMatchObject.learning.test.ts":
    "Records a Bun matcher behavior for local investigation after a Bun update.",
  "apps/cli/learning/tmuxSendKeys.learning.test.ts":
    "Records tmux input behavior for local investigation across tmux versions.",
  "apps/playground/convex/builder/agent.test.ts":
    "The Playground has a local test command and no CI test job.",
  "apps/playground/convex/builder/draft.test.ts":
    "The Playground has a local test command and no CI test job.",
  "apps/playground/convex/builder/queue.test.ts":
    "The Playground has a local test command and no CI test job.",
  "apps/playground/convex/builder/rules.test.ts":
    "The Playground has a local test command and no CI test job.",
  "apps/playground/convex/home.test.ts":
    "The Playground has a local test command and no CI test job.",
  "apps/playground/convex/lib/appData.test.ts":
    "The Playground has a local test command and no CI test job.",
  "apps/playground/convex/lib/bootCatcher.test.ts":
    "The Playground has a local test command and no CI test job.",
  "apps/playground/convex/lib/entryPage.test.ts":
    "The Playground has a local test command and no CI test job.",
  "apps/playground/convex/lib/identity.test.ts":
    "The Playground has a local test command and no CI test job.",
  "apps/playground/convex/lib/presence.test.ts":
    "The Playground has a local test command and no CI test job.",
  "apps/playground/convex/lib/room.test.ts":
    "The Playground has a local test command and no CI test job.",
  "apps/playground/convex/lib/runPaths.test.ts":
    "The Playground has a local test command and no CI test job.",
  "apps/playground/convex/lib/slugs.test.ts":
    "The Playground has a local test command and no CI test job.",
  "apps/playground/convex/lib/transpile.test.ts":
    "The Playground has a local test command and no CI test job.",
  "apps/playground/convex/lib/unfurl.test.ts":
    "The Playground has a local test command and no CI test job.",
  "apps/playground/convex/lib/versions.test.ts":
    "The Playground has a local test command and no CI test job.",
  "apps/playground/convex/prompts.test.ts":
    "The Playground has a local test command and no CI test job.",
  "apps/playground/convex/runtime.test.ts":
    "The Playground has a local test command and no CI test job.",
  "apps/playground/convex/safety.test.ts":
    "The Playground has a local test command and no CI test job.",
  "apps/playground/convex/timeline.test.ts":
    "The Playground has a local test command and no CI test job.",
  "apps/playground/runtime/picker.test.ts":
    "The Playground has a local test command and no CI test job.",
  "apps/playground/runtime/sdk.test.ts":
    "The Playground has a local test command and no CI test job.",
  "apps/playground/runtime/sharedUpdate.test.ts":
    "The Playground has a local test command and no CI test job.",
  "apps/playground/src/lib/format.test.ts":
    "The Playground has a local test command and no CI test job.",
  "apps/playground/src/lib/router.test.ts":
    "The Playground has a local test command and no CI test job.",
  "apps/playground/src/lib/streamOrder.test.ts":
    "The Playground has a local test command and no CI test job.",
  "apps/playground/src/lib/versionCopy.test.ts":
    "The Playground has a local test command and no CI test job.",
  "apps/playground/src/styles/keyframes.test.ts":
    "The Playground has a local test command and no CI test job.",
  "apps/vscode-extension/src/wsl.test.ts":
    "The VS Code extension has no test job or test step.",
  "infra/call-face-worker/vision.test.mjs": "Requires a local LiveKit server.",
  "infra/replay-player/src/worker.test.ts":
    "Requires an install in the replay player directory.",
  "scripts/lineFinders.test.ts":
    "Fails against the finders declared in the current line configuration.",
  "tests/fork/fork.test.ts": "Contacts a live server.",
};

const coverage = testCoverage();

test("every test file has a CI job or a reason for running manually", () => {
  const { jobs, unreached } = coverage;
  expect(unreached.filter((file) => !ALLOWED_UNREACHED[file])).toEqual([]);
  expect(
    Object.keys(ALLOWED_UNREACHED).filter((file) => !unreached.includes(file)),
  ).toEqual([]);
  expect([...jobs.get("computer-macos")!]).toContain(
    "apps/cli/src/computer/cli.test.ts",
  );
  expect([...jobs.get("test-cli")!]).not.toContain(
    "apps/cli/src/computer/cli.test.ts",
  );
});

test("CI test files register a test case", () => {
  const empty = [...coverage.covered].filter((file) => {
    const source = readFileSync(
      new URL(`../../${file}`, import.meta.url),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "");
    const call = /\b(test|it|specify)\s*(?:\.\w+\s*)*(?:\)\s*)?\(/;
    const aliases = [
      ...source.matchAll(/\bconst (\w+) = [^;]*\? test : test\.skip;/g),
    ];
    return (
      !call.test(source) &&
      !aliases.some(([, alias]) =>
        new RegExp(`\\b${alias}\\s*\\(`).test(source),
      )
    );
  });
  expect(empty.sort()).toEqual([]);
});
