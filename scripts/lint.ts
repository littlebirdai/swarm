import { rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { carryRenames, compareLintCounts, parseRenames, type LintCounts } from "./lib/lint-baseline";
import { LINT_ROOT, lintLocation, oxlintCommand, parseOxlintReport } from "./lib/oxlint";

const baselineName = "lint-baseline.json";
const baselinePath = path.join(LINT_ROOT, baselineName);

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
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1) {
        throw new Error(`Invalid lint baseline count for ${file} [${rule}].`);
      }
      counts[file]![rule] = count;
    }
  }
  return counts;
}

function baseBaseline(base: string): LintCounts | undefined {
  if (!/^[0-9a-f]{40}$/.test(base)) throw new Error("LINT_BASE_SHA must be a full Git commit SHA.");
  const listing = Bun.spawnSync(["git", "ls-tree", base, "--", baselineName], { cwd: LINT_ROOT });
  if (listing.exitCode !== 0) throw new Error(listing.stderr.toString().trim());
  if (!listing.stdout.length) return;

  const result = Bun.spawnSync(["git", "show", `${base}:${baselineName}`], { cwd: LINT_ROOT });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim());
  return readBaseline(result.stdout.toString());
}

function git(args: string[]): string | undefined {
  const result = Bun.spawnSync(["git", ...args], { cwd: LINT_ROOT });
  return result.exitCode === 0 ? result.stdout.toString() : undefined;
}

function renamesSince(base: string | undefined): Array<[string, string]> {
  const ref = base ?? git(["merge-base", "HEAD", "origin/main"])?.trim() ?? "HEAD";
  const out = git(["diff", "--find-renames", "--name-status", "-z", ref]);
  if (out === undefined) throw new Error(`Could not read renames since ${ref}.`);
  return parseRenames(out);
}

async function main(prune: boolean) {
  const renames = renamesSince(process.env.LINT_BASE_SHA);
  const baseline = carryRenames(readBaseline(await Bun.file(baselinePath).text()), renames);
  const baseCounts = process.env.LINT_BASE_SHA && baseBaseline(process.env.LINT_BASE_SHA);
  const base = baseCounts && carryRenames(baseCounts, renames);
  if (base) {
    const { grew } = compareLintCounts(base, baseline);
    for (const { file, rule, before, after } of grew) {
      console.error(`Baseline grew for ${file} [${rule}]: ${before} → ${after}.`);
    }
    if (grew.length) throw new Error("The lint baseline can only shrink.");
  }

  const oxlint = Bun.spawn(oxlintCommand([]), { cwd: LINT_ROOT, stdout: "pipe", stderr: "inherit" });
  const [stdout, exitCode] = await Promise.all([new Response(oxlint.stdout).text(), oxlint.exited]);
  if ((exitCode !== 0 && exitCode !== 1) || !stdout.trim()) {
    throw new Error(`Oxlint failed to produce diagnostics (exit ${exitCode}).`);
  }

  const { diagnostics, number_of_files: scanned } = parseOxlintReport(stdout);
  if (scanned === 0 || (exitCode !== 0 && diagnostics.length === 0)) {
    throw new Error(`Oxlint scanned ${scanned} files and reported ${diagnostics.length} diagnostics (exit ${exitCode}).`);
  }

  const current: LintCounts = Object.create(null);
  for (const diagnostic of diagnostics) {
    const { file, rule, message } = lintLocation(diagnostic);
    if (!file || file.startsWith("../")) throw new Error(`Oxlint [${rule}]: ${message}`);
    const rules = current[file] ??= Object.create(null);
    rules[rule] = (rules[rule] ?? 0) + 1;
  }

  const { grew, shrank, pruned } = compareLintCounts(baseline, current);
  for (const { file, rule, before, after } of grew) {
    console.error(`${file} [${rule}]: ${after} violations, baseline allows ${before}.`);
  }
  if (grew.length) throw new Error("Fix the lint violations above. The lint baseline can only shrink.");

  if (prune && shrank.length) {
    const tempPath = `${baselinePath}.tmp.${process.pid}.a`;
    await writeFile(tempPath, JSON.stringify(pruned, null, 2) + "\n");
    await rename(tempPath, baselinePath);
    console.log(`Pruned ${shrank.length} file/rule counts from ${baselineName}.`);
  } else if (shrank.length) {
    console.log(`${shrank.length} file/rule counts shrank. Run bun run lint:prune.`);
  }
  console.log(`Lint passed (${scanned} files, ${diagnostics.length} baselined diagnostics).`);
}

try {
  await main(process.argv.includes("--prune"));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
