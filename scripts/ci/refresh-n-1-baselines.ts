import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const REPO_ROOT = join(import.meta.dir, "../..");

export const CONTRACT_PACKAGES = [
  "packages/edge-contract",
  "packages/relay-contract",
] as const;

type BaselineManifest = {
  revision: string | null;
  hashes: Record<string, string>;
};

function runGit(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd });
  if (!result.success) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`,
    );
  }
  return result.stdout.toString();
}

export async function baselineHashes(
  dir: string,
): Promise<Record<string, string>> {
  const entries: Array<[string, string]> = [];
  for (const sub of ["schema", "fixtures"]) {
    const files = (await readdir(join(dir, sub))).sort();
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
  pkgDir: string,
  targetDir: string,
): Promise<void> {
  const schemaSrc = join(pkgDir, "src");
  const fixturesSrc = join(pkgDir, "test/fixtures");
  for (const file of (await readdir(schemaSrc)).sort()) {
    if (!file.endsWith(".ts")) continue;
    await writeFile(
      join(targetDir, "schema", file),
      await readFile(join(schemaSrc, file)),
    );
  }
  for (const file of (await readdir(fixturesSrc)).sort()) {
    if (!file.endsWith(".json")) continue;
    await writeFile(
      join(targetDir, "fixtures", file),
      await readFile(join(fixturesSrc, file)),
    );
  }
}

function copyFromRevision(
  repo: string,
  pkg: string,
  revision: string,
  targetDir: string,
): Promise<void[]> {
  const writes: Promise<void>[] = [];
  for (const [srcSub, ext, dstSub] of [
    ["src", ".ts", "schema"],
    ["test/fixtures", ".json", "fixtures"],
  ] as const) {
    const prefix = `${pkg}/${srcSub}/`;
    const listed = runGit(repo, "ls-tree", "--name-only", revision, prefix)
      .trim()
      .split("\n")
      .filter((entry) => entry.endsWith(ext));
    for (const path of listed) {
      const file = path.slice(prefix.length);
      writes.push(
        writeFile(
          join(targetDir, dstSub, file),
          runGit(repo, "show", `${revision}:${path}`),
        ),
      );
    }
  }
  return Promise.all(writes);
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
    await copyFromWorktree(pkgDir, targetDir);
  }

  const hashes = await baselineHashes(targetDir);
  const manifest: BaselineManifest = {
    revision: resolvedRevision,
    hashes,
  };
  await writeFile(
    join(targetDir, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
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
