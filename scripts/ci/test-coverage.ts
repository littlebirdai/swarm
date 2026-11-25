import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { alwaysRunFiles, SUITES } from "./always-run-tests";
import { packageTestDirectories } from "./package-tests";
import {
  bunFiles,
  filesForCommand,
  namesTestRunner,
  parseTestCommands,
  ROOT,
  TEST_FILE,
} from "./test-commands";
import { matrixEntries, selectedEntries } from "./test-job-matrix";

type Step = {
  if?: boolean | string;
  run?: string;
  "working-directory"?: string;
  "continue-on-error"?: boolean;
};
type Job = {
  if?: boolean | string;
  steps?: Step[];
  strategy?: { matrix: Record<string, Array<string | number | boolean>> };
  "continue-on-error"?: boolean;
};
type Workflow = { jobs: Record<string, Job> };

function gitTestFiles(): string[] {
  const git = Bun.spawnSync(
    ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: ROOT },
  );
  if (git.exitCode !== 0) throw new Error(git.stderr.toString());
  return [...new Set(git.stdout.toString().split("\0"))]
    .filter((file) => TEST_FILE.test(file) && existsSync(join(ROOT, file)))
    .sort();
}

function platformTestDirectories(): string[] {
  const listed = Bun.spawnSync(
    ["bash", "scripts/vendor-platform.sh", "--list-with-tests"],
    { cwd: ROOT },
  );
  if (listed.exitCode !== 0) throw new Error(listed.stderr.toString());
  return listed.stdout
    .toString()
    .trim()
    .split("\n")
    .map((pkg) => join("platform/packages", pkg));
}

export function testCoverage(
  workflow = Bun.YAML.parse(
    readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8"),
  ) as Workflow,
  files = gitTestFiles(),
) {
  const jobs = new Map<string, Set<string>>();
  const required = new Set<string>();
  const covered = new Set<string>();
  for (const [job, config] of Object.entries(workflow.jobs)) {
    const selected = new Set<string>();
    for (const step of config.steps ?? []) {
      if (!step.run || !namesTestRunner(step.run.replace(/\\\r?\n/g, " ")))
        continue;
      const dir = step["working-directory"] ?? ".";
      const entries = selectedEntries(config.strategy?.matrix, [
        config.if,
        step.if,
      ]);
      if (!entries.length) {
        parseTestCommands(
          step.run,
          dir,
          matrixEntries(config.strategy?.matrix)[0],
        );
        continue;
      }
      const commands = new Map(
        entries
          .flatMap((entry) => parseTestCommands(step.run!, dir, entry))
          .map((command) => [JSON.stringify(command), command]),
      );
      for (const command of commands.values()) {
        const reached =
          command.runner === "always"
            ? SUITES.flatMap((suite) =>
                alwaysRunFiles(suite).map((file) => join(suite.dir, file)),
              )
            : command.runner === "packages" || command.runner === "platform"
              ? (command.runner === "packages"
                  ? packageTestDirectories(ROOT)
                  : platformTestDirectories()
                ).flatMap((pkg) => bunFiles(pkg, [], files))
              : filesForCommand(command, dir, files);
        for (const file of reached) {
          selected.add(file);
          covered.add(file);
          if (!config["continue-on-error"] && !step["continue-on-error"])
            required.add(file);
        }
      }
    }
    if (selected.size) jobs.set(job, selected);
  }
  return {
    jobs,
    covered,
    advisoryOnly: files.filter(
      (file) => covered.has(file) && !required.has(file),
    ),
    unreached: files.filter((file) => !covered.has(file)),
  };
}

export const ADVISORY_REASON =
  "CI runs these files only in jobs or steps that allow failure.";

if (import.meta.main) {
  const { jobs, advisoryOnly, unreached } = testCoverage();
  for (const [job, files] of jobs) console.log(`${job}: ${files.size}`);
  console.log(ADVISORY_REASON);
  for (const file of advisoryOnly) console.log(file);
  console.log("CI does not run these files.");
  for (const file of unreached) console.log(file);
}
