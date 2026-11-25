#!/usr/bin/env bun
// The test files that run on every change, in the ungated `test-always` job.
//
// Two kinds:
// - Tree-wide tests: guards (`*.guard.test.*`) and ratchets
//   (`*.ratchet.test.*`). They read source trees off disk, often across
//   packages (the doc references guard checks every path the docs name, the
//   max lines ratchet walks every package), so no path filter can say which
//   change might break one.
// - Crossing tests: a file whose imports or disk reads reach an area its own
//   job does not gate on (test-reach.ts). The job can be skipped for a change
//   that breaks such a file, so the file runs here instead of widening the
//   job's gate for every file in it.
//
// Each package's files run from that package's directory with the flags its
// own job uses, so its bunfig preload and isolation apply. The package jobs
// still run these files too when they run.
//
// `bun scripts/ci/always-run-tests.ts` runs them; `--list` prints them.

import { join, relative } from "node:path";
import {
  crossingTests,
  JOB_TEST_ROOTS,
  jobTestFiles,
  TREE_WIDE_TEST,
} from "./test-reach";

const ROOT = join(import.meta.dir, "..", "..");

/**
 * Where each package's files run from, the directories its job tests, and the
 * `bun test` flags that job runs with.
 */
export const SUITES: Array<{
  job: string;
  dir: string;
  roots: string[];
  flags: string[];
}> = [
  ...JOB_TEST_ROOTS["test-shared"].map((dir) => ({
    job: "test-shared",
    dir,
    roots: ["."],
    flags: [],
  })),
  {
    job: "test-convex",
    dir: "apps/server",
    roots: ["convex", "scripts"],
    flags: [],
  },
  // test-cli runs --parallel, a fresh global per file: the boot graph guards
  // count the module registry, which earlier files in one process have filled.
  { job: "test-cli", dir: "apps/cli", roots: ["src"], flags: ["--parallel"] },
  {
    job: "test-cli",
    dir: "apps/evals",
    roots: ["src"],
    flags: ["--parallel"],
  },
  // test-web and test-mobile run with --isolate: their mount tests replace
  // modules with mock.module, which is permanent within one process.
  {
    job: "test-web",
    dir: "apps/web",
    roots: ["."],
    flags: ["--parallel=2", "--timeout=20000"],
  },
  {
    job: "test-mobile",
    dir: "apps/mobile",
    roots: ["."],
    flags: ["--isolate"],
  },
];

const filesByJob = new Map<string, string[]>();

function alwaysRunJobFiles(job: string): string[] {
  let files = filesByJob.get(job);
  if (!files) {
    const treeWide = jobTestFiles(job).filter((file) =>
      TREE_WIDE_TEST.test(file),
    );
    const crossing = crossingTests(job).map(({ file }) => join(ROOT, file));
    files = [...new Set([...treeWide, ...crossing])];
    filesByJob.set(job, files);
  }
  return files;
}

/** A suite's always-run files, relative to its package directory. */
export function alwaysRunFiles(suite: (typeof SUITES)[number]): string[] {
  const pkg = join(ROOT, suite.dir);
  const roots = suite.roots.map((root) => `${join(pkg, root)}/`);
  return alwaysRunJobFiles(suite.job)
    .filter((file) => roots.some((root) => file.startsWith(root)))
    .map((file) => `./${relative(pkg, file)}`)
    .sort();
}

async function runSuite(suite: (typeof SUITES)[number]): Promise<boolean> {
  const files = alwaysRunFiles(suite);
  if (files.length === 0) return true;
  const started = performance.now();
  console.log(`${suite.dir}: started`);
  const proc = Bun.spawn(["bun", "test", ...suite.flags, ...files], {
    cwd: join(ROOT, suite.dir),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 300_000,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const seconds = Math.round((performance.now() - started) / 1000);
  console.log(`::group::${suite.dir}: ${files.length} files`);
  console.log(stdout + stderr);
  console.log("::endgroup::");
  console.log(`${suite.dir}: exit ${code} in ${seconds}s`);
  return code === 0;
}

if (import.meta.main) {
  if (process.argv.includes("--list")) {
    for (const suite of SUITES) {
      const files = alwaysRunFiles(suite);
      console.log(`${suite.dir} (${files.length})`);
      for (const file of files) console.log(`  ${file}`);
    }
    process.exit(0);
  }
  const queue = [...SUITES];
  const failed: string[] = [];
  const worker = async () => {
    for (let suite = queue.pop(); suite; suite = queue.pop())
      if (!(await runSuite(suite))) failed.push(suite.dir);
  };
  await Promise.all(
    Array.from({ length: navigator.hardwareConcurrency }, worker),
  );
  if (failed.length > 0) {
    console.log(`::error::Always-run tests failed in ${failed.join(", ")}`);
    process.exit(1);
  }
}
