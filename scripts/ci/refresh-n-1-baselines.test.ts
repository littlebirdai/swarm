import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  assertFrozenSchemaImports,
  baselineHashes,
  refreshBaseline,
  transformFrozenSchema,
} from "./refresh-n-1-baselines";

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

test("refreshBaseline snapshots nested schema, fixtures, rewrites relay imports, formats before hashing, and writes manifest", async () => {
  repo = mkdtempSync(join(tmpdir(), "refresh-n1-"));
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.invalid");
  git(repo, "config", "commit.gpgsign", "false");

  writeRepoFile(
    repo,
    "packages/relay-contract/src/index.ts",
    "export const RELAY_MAX_GRANTS_PER_TOKEN = 8;\n",
  );
  writeRepoFile(
    repo,
    "packages/edge-contract/src/index.ts",
    'import { RELAY_MAX_GRANTS_PER_TOKEN } from "@codecast/relay-contract";\nexport * from "./nested/sub";\nexport const V = RELAY_MAX_GRANTS_PER_TOKEN;\n',
  );
  writeRepoFile(
    repo,
    "packages/edge-contract/src/nested/sub.ts",
    'import { RELAY_MAX_GRANTS_PER_TOKEN } from "@codecast/relay-contract";\nexport const SUB = RELAY_MAX_GRANTS_PER_TOKEN;\n',
  );
  writeRepoFile(
    repo,
    "packages/edge-contract/test/fixtures/hello.json",
    '{"request":{},"response":{}}\n',
  );
  writeRepoFile(
    repo,
    "packages/edge-contract/test/fixtures/nested/extra.json",
    '{"ok":true}\n',
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
  expect(await Bun.file(join(n1Dir, "schema/index.ts")).text()).toContain(
    'from "../../../../relay-contract/test/n-1/schema"',
  );
  expect(await Bun.file(join(n1Dir, "schema/nested/sub.ts")).text()).toContain(
    'from "../../../../../relay-contract/test/n-1/schema"',
  );
  expect(await Bun.file(join(n1Dir, "fixtures/hello.json")).text()).toBe(
    '{ "request": {}, "response": {} }\n',
  );
  expect(await Bun.file(join(n1Dir, "fixtures/nested/extra.json")).text()).toBe(
    '{ "ok": true }\n',
  );
  expect(manifest.hashes["schema/nested/sub.ts"]).toBeDefined();
  expect(manifest.hashes["fixtures/nested/extra.json"]).toBeDefined();
  expect(await baselineHashes(n1Dir)).toEqual(manifest.hashes);
});

test("transformFrozenSchema rejects live workspace and src imports", () => {
  expect(() =>
    transformFrozenSchema(
      "/repo",
      "packages/edge-contract",
      "claims.ts",
      'import { X } from "@codecast/session-contract";\nexport const x = X;\n',
    ),
  ).toThrow(/disallowed non-relative import/);

  expect(() =>
    assertFrozenSchemaImports(
      "/repo",
      "packages/relay-contract",
      "index.ts",
      'import type { Y } from "@codecast/edge-contract";\nexport type Z = Y;\n',
    ),
  ).toThrow(/disallowed non-relative import/);

  expect(() =>
    assertFrozenSchemaImports(
      "/repo",
      "packages/edge-contract",
      "claims.ts",
      'import { X } from "../../src/claims";\nexport const x = X;\n',
    ),
  ).toThrow(/outside frozen N-1 directories/);
});
