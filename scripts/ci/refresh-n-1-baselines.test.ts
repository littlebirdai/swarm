import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { baselineHashes, refreshBaseline } from "./refresh-n-1-baselines";

let repo: string;
afterEach(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd });
  if (!result.success) throw new Error(result.stderr.toString().trim());
  return result.stdout.toString().trim();
}

function writeRepoFile(root: string, rel: string, contents: string): void {
  const dest = join(root, rel);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, contents);
}

test("refreshBaseline snapshots schema, fixtures, and manifest hashes from a git revision", async () => {
  repo = mkdtempSync(join(tmpdir(), "refresh-n1-"));
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.invalid");
  git(repo, "config", "commit.gpgsign", "false");

  writeRepoFile(
    repo,
    "packages/edge-contract/src/index.ts",
    "export const V = 1;\n",
  );
  writeRepoFile(
    repo,
    "packages/edge-contract/test/fixtures/hello.json",
    '{"request":{},"response":{}}\n',
  );
  git(repo, "add", ".");
  git(repo, "commit", "-m", "v1");
  const v1 = git(repo, "rev-parse", "HEAD");

  writeRepoFile(
    repo,
    "packages/edge-contract/src/index.ts",
    "export const V = 2;\n",
  );
  git(repo, "add", ".");
  git(repo, "commit", "-m", "v2");

  const manifest = await refreshBaseline(repo, "packages/edge-contract", v1);
  expect(manifest.revision).toBe(v1);
  const n1Dir = join(repo, "packages/edge-contract/test/n-1");
  expect(await Bun.file(join(n1Dir, "schema/index.ts")).text()).toBe(
    "export const V = 1;\n",
  );
  expect(await Bun.file(join(n1Dir, "fixtures/hello.json")).text()).toBe(
    '{"request":{},"response":{}}\n',
  );
  expect(await baselineHashes(n1Dir)).toEqual(manifest.hashes);
});
