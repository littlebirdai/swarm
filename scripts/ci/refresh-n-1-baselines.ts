import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const REPO_ROOT = join(import.meta.dir, "../..");

export const CONTRACT_PACKAGES = [
  "packages/edge-contract",
  "packages/relay-contract",
] as const;

type BaselineManifest = {
  revision: string | null;
  hashes: Record<string, string>;
};

const RELAY_CONTRACT_PKG = "packages/relay-contract";
const IMPORT_RE =
  /(?:^|[;\r\n])\s*(?:import|export)\s+(?:(?:type\s+)?[^;]*?\s+from\s+)?(["'])([^"']+)\1/gm;
const RELAY_SPECIFIER_RE = /(["'])@codecast\/relay-contract\1/g;
const tsTranspiler = new Bun.Transpiler({ loader: "ts" });

function toPosix(path: string): string {
  return path.split("\\").join("/");
}

function isInsideRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function scanSpecifiers(source: string): string[] {
  const found = new Set<string>();
  for (const item of tsTranspiler.scanImports(source)) {
    found.add(item.path);
  }
  for (const match of source.matchAll(IMPORT_RE)) {
    found.add(match[2]!);
  }
  return [...found];
}

export function assertFrozenSchemaImports(
  repo: string,
  pkg: string,
  relFile: string,
  source: string,
): void {
  const ownSchemaRoot = resolve(repo, pkg, "test/n-1/schema");
  const relaySchemaRoot = resolve(repo, RELAY_CONTRACT_PKG, "test/n-1/schema");
  const fileDir = dirname(resolve(ownSchemaRoot, relFile));

  for (const specifier of scanSpecifiers(source)) {
    if (!specifier.startsWith(".")) {
      throw new Error(
        `Frozen N-1 schema ${pkg}/test/n-1/schema/${relFile} has disallowed non-relative import "${specifier}"`,
      );
    }
    const target = resolve(fileDir, specifier);
    const inOwn = isInsideRoot(ownSchemaRoot, target);
    const inRelay =
      pkg !== RELAY_CONTRACT_PKG && isInsideRoot(relaySchemaRoot, target);
    if (!inOwn && !inRelay) {
      throw new Error(
        `Frozen N-1 schema ${pkg}/test/n-1/schema/${relFile} imports "${specifier}" outside frozen N-1 directories`,
      );
    }
  }
}

export function transformFrozenSchema(
  repo: string,
  pkg: string,
  relFile: string,
  source: string,
): string {
  let next = source;
  if (pkg !== RELAY_CONTRACT_PKG) {
    const fileDir = dirname(resolve(repo, pkg, "test/n-1/schema", relFile));
    const relaySchemaRoot = resolve(
      repo,
      RELAY_CONTRACT_PKG,
      "test/n-1/schema",
    );
    const relPath = toPosix(relative(fileDir, relaySchemaRoot));
    const specifier = relPath.startsWith(".") ? relPath : `./${relPath}`;
    next = next.replace(
      RELAY_SPECIFIER_RE,
      (_, quote: string) => `${quote}${specifier}${quote}`,
    );
  }
  assertFrozenSchemaImports(repo, pkg, relFile, next);
  return next;
}

function runGit(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd });
  if (!result.success) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`,
    );
  }
  return result.stdout.toString();
}

function runOxfmt(...paths: string[]): void {
  const oxfmtBin = join(REPO_ROOT, "node_modules/.bin/oxfmt");
  const result = Bun.spawnSync([oxfmtBin, ...paths], { cwd: REPO_ROOT });
  if (!result.success) {
    throw new Error(
      `oxfmt ${paths.join(" ")} failed: ${result.stderr.toString().trim()}`,
    );
  }
}

async function walkFiles(dir: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const files: string[] = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(full, rel)));
    } else if (entry.isFile()) {
      files.push(rel);
    }
  }
  return files;
}

export async function baselineHashes(
  dir: string,
): Promise<Record<string, string>> {
  const entries: Array<[string, string]> = [];
  for (const sub of ["schema", "fixtures"]) {
    const files = await walkFiles(join(dir, sub));
    for (const file of files) {
      const rel = `${sub}/${file}`;
      const bytes = await readFile(join(dir, rel));
      entries.push([
        rel,
        new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
      ]);
    }
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries);
}

async function copyFromWorktree(
  repo: string,
  pkg: string,
  pkgDir: string,
  targetDir: string,
): Promise<void> {
  const schemaSrc = join(pkgDir, "src");
  const fixturesSrc = join(pkgDir, "test/fixtures");
  for (const file of await walkFiles(schemaSrc)) {
    if (!file.endsWith(".ts")) continue;
    const dest = join(targetDir, "schema", file);
    await mkdir(dirname(dest), { recursive: true });
    const raw = await readFile(join(schemaSrc, file), "utf8");
    await writeFile(dest, transformFrozenSchema(repo, pkg, file, raw));
  }
  for (const file of await walkFiles(fixturesSrc)) {
    if (!file.endsWith(".json")) continue;
    const dest = join(targetDir, "fixtures", file);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, await readFile(join(fixturesSrc, file)));
  }
}

async function copyFromRevision(
  repo: string,
  pkg: string,
  revision: string,
  targetDir: string,
): Promise<void> {
  for (const [srcSub, ext, dstSub] of [
    ["src", ".ts", "schema"],
    ["test/fixtures", ".json", "fixtures"],
  ] as const) {
    const prefix = `${pkg}/${srcSub}/`;
    const listed = runGit(
      repo,
      "ls-tree",
      "-r",
      "--name-only",
      revision,
      prefix,
    )
      .trim()
      .split("\n")
      .filter((entry) => entry.endsWith(ext));
    for (const path of listed) {
      const file = path.slice(prefix.length);
      const dest = join(targetDir, dstSub, file);
      await mkdir(dirname(dest), { recursive: true });
      const raw = runGit(repo, "show", `${revision}:${path}`);
      const content =
        dstSub === "schema" ? transformFrozenSchema(repo, pkg, file, raw) : raw;
      await writeFile(dest, content);
    }
  }
}

export async function refreshBaseline(
  repo: string,
  pkg: string,
  revision?: string,
): Promise<BaselineManifest> {
  const pkgDir = join(repo, pkg);
  const targetDir = join(pkgDir, "test/n-1");
  await rm(targetDir, { recursive: true, force: true });
  await mkdir(join(targetDir, "schema"), { recursive: true });
  await mkdir(join(targetDir, "fixtures"), { recursive: true });

  const resolvedRevision = revision
    ? runGit(repo, "rev-parse", "--verify", `${revision}^{commit}`).trim()
    : null;
  if (resolvedRevision) {
    await copyFromRevision(repo, pkg, resolvedRevision, targetDir);
  } else {
    await copyFromWorktree(repo, pkg, pkgDir, targetDir);
  }

  runOxfmt(join(targetDir, "schema"), join(targetDir, "fixtures"));

  const hashes = await baselineHashes(targetDir);
  const manifest: BaselineManifest = {
    revision: resolvedRevision,
    hashes,
  };
  const manifestPath = join(targetDir, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  runOxfmt(manifestPath);
  return manifest;
}

if (import.meta.main) {
  const revFlag = process.argv.indexOf("--rev");
  const revision = revFlag >= 0 ? process.argv[revFlag + 1] : undefined;
  if (revFlag >= 0 && !revision) {
    throw new Error(
      "usage: bun scripts/ci/refresh-n-1-baselines.ts [--rev <git-ref>]",
    );
  }
  for (const pkg of CONTRACT_PACKAGES) {
    await refreshBaseline(REPO_ROOT, pkg, revision);
  }
}
