import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunFiles, parseTestCommands } from "./test-commands";
import { ADVISORY_REASON, testCoverage } from "./test-coverage";
import { registersTest } from "./test-registration";

const ALLOWED_UNREACHED = {
  "infra/call-face-worker/vision.test.mjs": "Requires a local LiveKit server.",
  "infra/replay-player/src/worker.test.ts":
    "Requires an install in the replay player directory.",
};
const MACOS_ADVISORY_FILES = [
  "apps/cli/scripts/prompt-dry-run.broker.guard.test.ts",
  "apps/cli/scripts/prompt-dry-run.fake.guard.test.ts",
  "apps/cli/scripts/prompt-dry-run.replay.guard.test.ts",
  "apps/cli/scripts/prompt-dry-run.sandbox.guard.test.ts",
  "apps/cli/src/computer/batch.test.ts",
  "apps/cli/src/computer/capabilities.guard.test.ts",
  "apps/cli/src/computer/cli.e2e.test.ts",
  "apps/cli/src/computer/cli.test.ts",
  "apps/cli/src/computer/client.test.ts",
  "apps/cli/src/computer/computer.e2e.test.ts",
  "apps/cli/src/computer/concurrency.e2e.test.ts",
  "apps/cli/src/computer/entry.test.ts",
  "apps/cli/src/computer/focusRaise.guard.test.ts",
  "apps/cli/src/computer/granted.e2e.test.ts",
  "apps/cli/src/computer/guidance.test.ts",
  "apps/cli/src/computer/helper.e2e.test.ts",
  "apps/cli/src/computer/helperApp.test.ts",
  "apps/cli/src/computer/helperPayload.compile.test.ts",
  "apps/cli/src/computer/instance.test.ts",
  "apps/cli/src/computer/launchObserver.test.ts",
  "apps/cli/src/computer/linux/helper.test.ts",
  "apps/cli/src/computer/permissions.test.ts",
  "apps/cli/src/computer/pixels.test.ts",
  "apps/cli/src/computer/remote.test.ts",
  "apps/cli/src/computer/remoteGrant.test.ts",
  "apps/cli/src/computer/setup.test.ts",
  "apps/cli/src/computer/tree.test.ts",
  "apps/cli/src/computer/ungranted.e2e.test.ts",
  "apps/cli/src/computer/verdict.test.ts",
];

const coverage = testCoverage();

test("every test file has a CI job or a reason for manual use", () => {
  expect(coverage.unreached).toEqual(Object.keys(ALLOWED_UNREACHED));
  expect(coverage.jobs.get("computer-macos")).toContain(
    "apps/cli/src/computer/cli.test.ts",
  );
  expect(coverage.jobs.get("test-cli")).not.toContain(
    "apps/cli/src/computer/cli.test.ts",
  );
});

test("the coverage report lists advisory-only files separately", () => {
  expect(coverage.advisoryOnly, ADVISORY_REASON).toEqual(MACOS_ADVISORY_FILES);
});

test("CI test files register a test case", () => {
  const empty = [...coverage.covered].filter((file) => {
    const source = readFileSync(
      new URL(`../../${file}`, import.meta.url),
      "utf8",
    );
    return !registersTest(file, source);
  });
  expect(empty.sort()).toEqual([]);
});

test.each(["# bun test ./case.test.ts", "echo 'bun test ./case.test.ts'"])(
  "does not count shell text %s",
  (run) => {
    const file = "case.test.ts";
    expect(
      testCoverage({ jobs: { test: { steps: [{ run }] } } }, [file]).unreached,
    ).toEqual([file]);
  },
);

test.each([
  "bun test -t case",
  "bun test --test-name-pattern=case",
  "bun test --test-name-pattern case",
  "bun test || true",
  "if false; then\n  bun test\nfi",
  "exit 0\nbun test",
  "bunx vitest run",
  "echo ignored; bun test",
])("rejects the unsupported shell command %s", (run) => {
  expect(() => parseTestCommands(run, ".")).toThrow(
    "Unsupported CI test command",
  );
});

test("a matrix step needs at least one eligible entry", () => {
  const matrix = { suite: [1, "evals", "tmux-1"] };
  const files = ["alive.test.ts", "dead.test.ts"];
  const result = testCoverage(
    {
      jobs: {
        test: {
          if: "needs.code_paths.outputs.run_test_cli == 'true'",
          strategy: { matrix },
          steps: [
            {
              if: "matrix.suite != 'evals' && !startsWith(matrix.suite, 'tmux-') && matrix.suite == 1",
              run: "bun test ./alive.test.ts",
            },
            {
              if: "${{ matrix.suite == 'other' && needs.code_paths.outputs.run_test_cli == 'true' }}",
              run: "bun test ./dead.test.ts",
            },
            {
              if: "startsWith(matrix.suite, 'tmux-') && needs.code_paths.outputs.run_test_cli != 'true'",
              run: "bun test ./dead.test.ts",
            },
          ],
        },
      },
    },
    files,
  );
  expect(result.unreached).toEqual(["dead.test.ts"]);
});

test("Bun discovery uses the config root, ignore patterns and visible directories", () => {
  const root = mkdtempSync(join(tmpdir(), "ci-test-discovery-"));
  try {
    writeFileSync(
      join(root, "bunfig.toml"),
      '[test]\nroot = "selected"\npathIgnorePatterns = ["**/ignored/**"]\n',
    );
    const files = [
      "outside.test.ts",
      "selected/case.test.ts",
      "selected/ignored/case.test.ts",
      "selected/.hidden/case.test.ts",
    ];
    expect(bunFiles(".", [], files, root)).toEqual(["selected/case.test.ts"]);
    expect(bunFiles(".", ["--path-ignore-patterns="], files, root)).toEqual([
      "selected/case.test.ts",
      "selected/ignored/case.test.ts",
    ]);
    expect(bunFiles(".", ["./outside.test.ts"], files, root)).toEqual([
      "outside.test.ts",
    ]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test.each([
  '/test/.test("case")',
  "\"test('case', () => {})\"",
  '// test("case", () => {})',
  'test.skip("case", () => {})',
  'it.todo("case")',
  'describe.skip("suite", () => { test("case", () => {}); });',
  'if (false) test("case", () => {});',
  'test.if(false)("case", () => {})',
  'test.skipIf(true)("case", () => {})',
  "test.each([1])",
  'function unused() { test("case", () => {}); }',
  'unlistedHelper("case", () => {})',
  'import { it } from "./other"; it.effect("case", () => {});',
  'import type { it } from "@codecast/effect-kit/effect/testing"; it.effect("case", () => {});',
])("does not find a registered test in %s", (text) => {
  expect(registersTest("case.test.ts", text)).toBe(false);
});

test.each([
  'test("case", () => {})',
  'it("case", () => {})',
  'test.each([1])("case", () => {})',
  'test.if(guard)("case", () => {})',
  'test.skipIf(guard)("case", () => {})',
  'const conditional = guard ? test : test.skip; conditional("case", () => {});',
  'const cliTest = (name, body) => test(name, body); cliTest("case", () => {});',
  'import { it as check } from "@codecast/effect-kit/effect/testing"; check.effect("case", () => {});',
  'import { granted as check } from "./test-helper"; check("case", () => {});',
])("finds a registered test in %s", (text) => {
  expect(registersTest("case.test.ts", text)).toBe(true);
});

test.each([
  { defaults: {}, jobs: {} },
  { jobs: { test: { defaults: {}, steps: [] } } },
  { jobs: { test: { steps: [{ shell: "bash {0}", run: "bun test" }] } } },
  { jobs: { test: { steps: [{ run: "bun test --shard=1/8" }] } } },
])("rejects a workflow that can hide a test failure: %j", (workflow) => {
  expect(() => testCoverage(workflow, [])).toThrow();
});
