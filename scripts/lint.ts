import { readdirSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  carryRenames,
  compareLintCounts,
  matchLintTransfers,
  parseRenames,
  staleFiles,
  type CountChange,
  type DiagnosticSpans,
  type LintCounts,
} from "./lib/lint-baseline";
import {
  LINT_ROOT,
  diagnosticLines,
  lintLocation,
  lintSourceText,
  oxlintCommand,
  parseOxlintReport,
  type OxlintDiagnostic,
} from "./lib/oxlint";

const baselineName = "lint-baseline.json";
const baselinePath = path.join(LINT_ROOT, baselineName);

function exactFileLookup(root: string) {
  const directories = new Map<string, Set<string>>();
  return (file: string): boolean => {
    let dir = root;
    for (const name of file.split("/")) {
      let entries = directories.get(dir);
      if (!entries) {
        try {
          entries = new Set(readdirSync(dir));
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
          entries = new Set();
        }
        directories.set(dir, entries);
      }
      if (!entries.has(name)) return false;
      dir = path.join(dir, name);
    }
    return true;
  };
}

function readBaseline(contents: string): LintCounts {
  const value: unknown = JSON.parse(contents);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid lint baseline. Expected counts by file and rule.");
  }
  const counts: LintCounts = Object.create(null);
  for (const [file, rules] of Object.entries(value)) {
    if (!rules || typeof rules !== "object" || Array.isArray(rules)) {
      throw new Error(`Invalid lint baseline entry for ${file}.`);
    }
    counts[file] = Object.create(null);
    for (const [rule, count] of Object.entries(rules)) {
      if (
        typeof count !== "number" ||
        !Number.isSafeInteger(count) ||
        count < 1
      ) {
        throw new Error(`Invalid lint baseline count for ${file} [${rule}].`);
      }
      counts[file]![rule] = count;
    }
  }
  return counts;
}

function baseBaseline(base: string): LintCounts | undefined {
  if (!git(["ls-tree", base, "--", baselineName]).length) return;
  return readBaseline(git(["show", `${base}:${baselineName}`]).toString());
}

function git(args: string[]): Buffer {
  const result = Bun.spawnSync(["git", ...args], { cwd: LINT_ROOT });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim());
  return result.stdout;
}

function lintBase(): string {
  const sha = process.env.LINT_BASE_SHA;
  if (sha) {
    if (!/^[0-9a-f]{40}$/.test(sha))
      throw new Error("LINT_BASE_SHA must be a full Git commit SHA.");
  }
  const result = Bun.spawnSync(
    ["git", "merge-base", "HEAD", sha || "origin/main"],
    { cwd: LINT_ROOT },
  );
  return result.exitCode === 0
    ? result.stdout.toString().trim()
    : sha || "HEAD";
}

async function runOxlint(cwd: string, files: string[] = []) {
  const oxlint = Bun.spawn(
    oxlintCommand(files.length ? ["--", ...files] : []),
    {
      cwd,
      stdout: "pipe",
      stderr: "inherit",
    },
  );
  const [stdout, exitCode] = await Promise.all([
    new Response(oxlint.stdout).text(),
    oxlint.exited,
  ]);
  if ((exitCode !== 0 && exitCode !== 1) || !stdout.trim()) {
    throw new Error(`Oxlint failed to produce diagnostics (exit ${exitCode}).`);
  }

  const { diagnostics, number_of_files: scanned } = parseOxlintReport(stdout);
  if (
    (!files.length && scanned === 0) ||
    (exitCode !== 0 && diagnostics.length === 0)
  ) {
    throw new Error(
      `Oxlint scanned ${scanned} files and reported ${diagnostics.length} diagnostics (exit ${exitCode}).`,
    );
  }
  return { diagnostics, scanned };
}

function locateDiagnostic(diagnostic: OxlintDiagnostic, cwd: string) {
  const { file, rule, message } = lintLocation(
    cwd === LINT_ROOT || !diagnostic.filename
      ? diagnostic
      : {
          ...diagnostic,
          filename: path.relative(cwd, path.resolve(cwd, diagnostic.filename)),
        },
  );
  if (!file || file === ".." || file.startsWith("../"))
    throw new Error(`Oxlint [${rule}]: ${message}`);
  return { file, rule };
}

async function readSpans(
  cwd: string,
  diagnostics: OxlintDiagnostic[],
  files: Set<string>,
): Promise<DiagnosticSpans> {
  const spans: DiagnosticSpans = new Map();
  const sources = new Map<string, Buffer>();
  const exists = exactFileLookup(cwd);
  for (const file of files) {
    if (!exists(file)) continue;
    const source = Buffer.from(
      await Bun.file(path.join(cwd, file)).arrayBuffer(),
    );
    sources.set(file, source);
    spans.set(file, {
      source: `\n${lintSourceText(source)}\n`,
      rules: new Map(),
    });
  }
  for (const diagnostic of diagnostics) {
    const { file, rule } = locateDiagnostic(diagnostic, cwd);
    const source = sources.get(file);
    if (!source) continue;
    const lines = diagnosticLines(diagnostic, source);
    if (lines === undefined) continue;
    const { rules } = spans.get(file)!;
    const texts = rules.get(rule) ?? [];
    texts.push(lines);
    rules.set(rule, texts);
  }
  return spans;
}

async function baseSpans(
  sha: string,
  files: Map<string, string>,
): Promise<DiagnosticSpans> {
  const dir = await mkdtemp(path.join(tmpdir(), "swarm-lint-"));
  try {
    const configName = ".oxlintrc.json";
    const config = (await Bun.file(
      path.join(LINT_ROOT, configName),
    ).json()) as {
      jsPlugins?: string[];
    };
    config.jsPlugins = config.jsPlugins?.map((plugin) =>
      plugin.startsWith(".") ? path.resolve(LINT_ROOT, plugin) : plugin,
    );
    await writeFile(path.join(dir, configName), JSON.stringify(config));
    for (const file of files.keys()) {
      const target = path.join(dir, file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, git(["show", `${sha}:${file}`]));
    }
    const { diagnostics } = await runOxlint(dir, [...files.keys()]);
    const spans = await readSpans(dir, diagnostics, new Set(files.keys()));
    return new Map(
      [...spans].map(([file, rules]) => [files.get(file)!, rules]),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function checkBase(
  sha: string,
  base: LintCounts,
  baseline: LintCounts,
  current: LintCounts,
  diagnostics: OxlintDiagnostic[],
  renames: Array<[string, string]>,
  prune: boolean,
) {
  const actual = compareLintCounts(base, current);
  const saved = compareLintCounts(base, baseline);
  const candidates = [...actual.grew, ...saved.grew].filter(
    ({ file }) => !Object.hasOwn(base, file),
  );
  const eligible = new Set<string>();
  let matched: CountChange[] = [];
  let savedGrowth = saved.grew;
  if (candidates.length) {
    const basePaths = new Set(
      git(["ls-tree", "-r", "--name-only", "-z", sha]).toString().split("\0"),
    );
    const changed = new Set(
      git(["diff", "--no-renames", "--name-only", "-z", sha])
        .toString()
        .split("\0"),
    );
    const oldPaths = new Map(renames.map(([from, to]) => [to, from]));
    for (const { file } of candidates) {
      if (!basePaths.has(file) && !oldPaths.has(file)) eligible.add(file);
    }
    const requests = actual.grew.filter(({ file }) => eligible.has(file));
    matched = requests;
    const rules = new Set(requests.map(({ rule }) => rule));
    const donations = actual.shrank.filter(
      ({ file, rule }) =>
        rules.has(rule) &&
        basePaths.has(oldPaths.get(file) ?? file) &&
        changed.has(oldPaths.get(file) ?? file),
    );
    if (donations.length) {
      const files = new Map(
        donations.map(({ file }) => [oldPaths.get(file) ?? file, file]),
      );
      const before = await baseSpans(sha, files);
      const after = await readSpans(
        LINT_ROOT,
        diagnostics,
        new Set([...eligible, ...files.values()]),
      );
      matched = matchLintTransfers(donations, requests, before, after);

      if (!prune && matched.every(({ before, after }) => before === after)) {
        const savedDonations = donations
          .map((change) => ({
            ...change,
            after: Math.max(
              change.after,
              baseline[change.file]?.[change.rule] ?? 0,
            ),
          }))
          .filter(({ before, after }) => before > after);
        const savedRequests = saved.grew.filter(({ file }) =>
          eligible.has(file),
        );
        savedGrowth = [
          ...saved.grew.filter(({ file }) => !eligible.has(file)),
          ...matchLintTransfers(savedDonations, savedRequests, before, after),
        ];
      }
    }
  }

  const rejected = savedGrowth.filter(
    ({ file, before, after }) => before < after && !eligible.has(file),
  );
  for (const { file, rule, before, after } of rejected) {
    console.error(`Baseline grew for ${file} [${rule}]: ${before} → ${after}.`);
  }
  if (rejected.length) throw new Error("The lint baseline can only shrink.");

  const runtimeFailures = matched.some(({ before, after }) => before < after);
  if (!prune && !runtimeFailures) {
    const mismatch = compareLintCounts(baseline, current);
    const unsaved = new Set(
      [
        ...savedGrowth.filter(
          ({ file, before, after }) => eligible.has(file) && before < after,
        ),
        ...[...mismatch.grew, ...mismatch.shrank].filter(({ file }) =>
          eligible.has(file),
        ),
      ].map(({ file, rule }) => `${file} [${rule}]`),
    );
    if (unsaved.size) {
      for (const location of unsaved)
        console.error(
          `Baseline counts do not match the transfer for ${location}.`,
        );
      throw new Error(
        "Run bun run lint:prune to record the lint baseline transfers.",
      );
    }
  }

  const allowed: LintCounts = Object.assign(Object.create(null), baseline);
  for (const file of eligible) delete allowed[file];
  for (const { file, rule, before } of matched) {
    if (before > 0) (allowed[file] ??= Object.create(null))[rule] = before;
  }
  return allowed;
}

async function main(prune: boolean) {
  const sha = lintBase();
  const renames = parseRenames(
    git(["diff", "--find-renames", "--name-status", "-z", sha]).toString(),
  );
  const onDisk = readBaseline(await Bun.file(baselinePath).text());
  const stale = staleFiles(onDisk, exactFileLookup(LINT_ROOT));
  const baseline = carryRenames(onDisk, renames);
  const baseCounts = baseBaseline(sha);

  const { diagnostics, scanned } = await runOxlint(LINT_ROOT);
  const current: LintCounts = Object.create(null);
  for (const diagnostic of diagnostics) {
    const { file, rule } = locateDiagnostic(diagnostic, LINT_ROOT);
    const rules = (current[file] ??= Object.create(null));
    rules[rule] = (rules[rule] ?? 0) + 1;
  }

  const allowed = baseCounts
    ? await checkBase(
        sha,
        carryRenames(baseCounts, renames),
        baseline,
        current,
        diagnostics,
        renames,
        prune,
      )
    : baseline;
  const { grew, pruned } = compareLintCounts(allowed, current);
  const { grew: transferred, shrank } = compareLintCounts(baseline, current);
  for (const { file, rule, before, after } of grew) {
    console.error(
      `${file} [${rule}]: ${after} violations, baseline allows ${before}.`,
    );
  }
  if (grew.length)
    throw new Error(
      "Fix the lint violations above. The lint baseline can only shrink.",
    );

  if (stale.length && !prune) {
    for (const file of stale) {
      console.error(`${baselineName} names ${file}, which no longer exists.`);
    }
    throw new Error(
      "Run bun run lint:prune to move or drop those baseline entries.",
    );
  }

  if (prune && (transferred.length || shrank.length || stale.length)) {
    const tempPath = `${baselinePath}.tmp.${process.pid}.a`;
    await writeFile(tempPath, JSON.stringify(pruned, null, 2) + "\n");
    await rename(tempPath, baselinePath);
    console.log(
      `Updated ${baselineName} with ${transferred.length} transferred and ${shrank.length} reduced file/rule counts. Removed ${stale.length} stale paths.`,
    );
  } else if (transferred.length || shrank.length) {
    console.log("Run bun run lint:prune to record the lint baseline changes.");
  }
  console.log(
    `Lint passed (${scanned} files, ${diagnostics.length} baselined diagnostics).`,
  );
}

try {
  await main(process.argv.includes("--prune"));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
