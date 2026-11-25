import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { alwaysRunFiles, SUITES } from "./always-run-tests";
import { packageTestDirectories } from "./package-tests";

const ROOT = join(import.meta.dir, "../..");
const TEST_FILE = /[._](test|spec)\.[cm]?[jt]sx?$/;
type Step = {
  if?: boolean | string;
  run?: string;
  "working-directory"?: string;
};
type Workflow = {
  jobs: Record<string, { if?: boolean | string; steps?: Step[] }>;
};

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

function packageScript(dir: string, name: string): string {
  const pkg = JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8"));
  return pkg.scripts[name];
}

function bunIgnores(dir: string): string[] {
  const config = join(ROOT, dir, "bunfig.toml");
  if (!existsSync(config)) return [];
  const parsed = Bun.TOML.parse(readFileSync(config, "utf8")) as {
    test?: { pathIgnorePatterns?: string[] };
  };
  return parsed.test?.pathIgnorePatterns ?? [];
}

function bunFiles(dir: string, args: string[], files: string[]): string[] {
  const ignoreFlags = args.filter((arg) =>
    arg.startsWith("--path-ignore-patterns="),
  );
  const ignores = ignoreFlags.length
    ? ignoreFlags
        .map((arg) => arg.slice("--path-ignore-patterns=".length))
        .filter(Boolean)
    : bunIgnores(dir);
  const ignoreGlobs = ignores.map((pattern) => new Bun.Glob(pattern));
  const filters = args.filter((arg) => !arg.startsWith("-"));
  return files.filter((file) => {
    const path = relative(dir, file);
    if (path.startsWith("../")) return false;
    if (ignoreGlobs.some((glob) => glob.match(join(ROOT, file)))) return false;
    return (
      !filters.length ||
      filters.some((filter) =>
        filter.startsWith("./")
          ? `./${path}`.startsWith(filter)
          : path.includes(filter),
      )
    );
  });
}

function filesForTestCommands(
  run: string,
  dir: string,
  files: string[],
): string[] {
  run = run.replace(/\\\n/g, " ");
  const tests: string[] = [];
  for (const match of run.matchAll(
    /\bbun (?:run )?(test(?::[\w-]+)?)(?=[ \t\n;]|$)([^\n;]*)/g,
  )) {
    const [, command, rawArgs] = match;
    if (match[0].startsWith("bun run ") || command !== "test") {
      tests.push(
        ...filesForTestCommands(packageScript(dir, command), dir, files),
      );
      continue;
    }
    const args = rawArgs
      .replace(/\$\{\{.*?\}\}/g, "matrix")
      .replace(/--timeout\s+\d+/g, "")
      .replace(/['"]/g, "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    tests.push(...bunFiles(dir, args, files));
  }
  for (const match of run.matchAll(/\bnode --test ([^\n;]*)/g)) {
    const paths = match[1]
      .split(/\s+/)
      .filter((arg) => arg && !arg.startsWith("-"));
    const globs = paths.map((pattern) => new Bun.Glob(pattern));
    tests.push(
      ...files.filter((file) => {
        const path = relative(dir, file);
        return (
          !path.startsWith("../") && globs.some((glob) => glob.match(path))
        );
      }),
    );
  }
  return tests;
}

export function testCoverage() {
  const files = gitTestFiles();
  const workflow = Bun.YAML.parse(
    readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8"),
  ) as Workflow;
  const jobs = new Map<string, Set<string>>();
  for (const [job, config] of Object.entries(workflow.jobs)) {
    if (config.if === false) continue;
    const selected = new Set<string>();
    for (const step of config.steps ?? []) {
      if (step.if === false) continue;
      const run = step.run ?? "";
      const dir = step["working-directory"] ?? ".";
      for (const file of filesForTestCommands(run, dir, files))
        selected.add(file);
      if (run === "bun scripts/ci/always-run-tests.ts")
        for (const suite of SUITES)
          for (const file of alwaysRunFiles(suite))
            selected.add(join(suite.dir, file));
      if (run === "bun scripts/ci/package-tests.ts")
        for (const pkg of packageTestDirectories(ROOT))
          for (const file of filesForTestCommands("bun test", pkg, files))
            selected.add(file);
      if (run === "scripts/vendor-platform.sh --test") {
        const listed = Bun.spawnSync(
          ["bash", "scripts/vendor-platform.sh", "--list-with-tests"],
          { cwd: ROOT },
        );
        if (listed.exitCode !== 0) throw new Error(listed.stderr.toString());
        for (const pkg of listed.stdout.toString().trim().split("\n"))
          for (const file of filesForTestCommands(
            "bun test",
            join("platform/packages", pkg),
            files,
          ))
            selected.add(file);
      }
    }
    if (selected.size) jobs.set(job, selected);
  }
  const covered = new Set(
    [...jobs.values()].flatMap((selected) => [...selected]),
  );
  return {
    jobs,
    covered,
    unreached: files.filter((file) => !covered.has(file)),
  };
}

if (import.meta.main) {
  const { jobs, unreached } = testCoverage();
  for (const [job, files] of jobs) console.log(`${job}: ${files.size}`);
  for (const file of unreached) console.log(file);
}
