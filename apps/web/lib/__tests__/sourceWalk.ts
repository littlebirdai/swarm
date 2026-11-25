import { codeLines } from "@codecast/test-helpers/codeLines";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const WEB_ROOT = join(import.meta.dir, "..", "..");
export const MOBILE_ROOT = join(WEB_ROOT, "..", "..", "apps", "mobile");

const SKIP_DIRS = new Set([
  "node_modules",
  "__tests__",
  ".next",
  ".expo",
  "dist",
  "ios",
  "android",
]);

// Every non-test .ts/.tsx source under `dir` (recursive). `keepTests` walks
// __tests__ directories too, for guards that police test files.
export function walkSources(
  dir: string,
  opts: { keepTests?: boolean } = {},
  out: string[] = [],
): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name) && !(opts.keepTests && name === "__tests__"))
      continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkSources(full, opts, out);
    else if (
      /\.tsx?$/.test(name) &&
      (opts.keepTests || !/\.test\.tsx?$/.test(name))
    )
      out.push(full);
  }
  return out;
}

// `${rel}:${n}: ${line}` for every code line under `dirs` (relative to
// `root`) that matches `token`, skipping allowlisted files.
export function offendersUnder(
  root: string,
  dirs: readonly string[],
  token: RegExp,
  allowed: ReadonlyMap<string, string> = new Map(),
): string[] {
  const offenders: string[] = [];
  for (const dir of dirs) {
    for (const file of walkSources(join(root, dir))) {
      const rel = file.slice(root.length + 1);
      if (allowed.has(rel)) continue;
      for (const { line, n } of codeLines(readFileSync(file, "utf8"))) {
        if (token.test(line)) offenders.push(`${rel}:${n}: ${line.trim()}`);
      }
    }
  }
  return offenders;
}

export function topLevelSelectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of list) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}
