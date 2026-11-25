import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  fixtureHashes,
  freezeRelease,
  git,
  readClientInventory,
  releaseBaseline,
  releasePath,
} from "./freeze-edge-contract";

const fixture = "packages/edge-contract/test/fixtures/hello.json";
const wire = '{"request":{"versions":[1]},"response":{"version":1}}\n';
const names = [
  "fn:messages:send",
  "fn:messages:unused",
  "http:POST /cli/heartbeat",
];
const inventory = async () => names;
let repo: string;
afterEach(() => rmSync(repo, { recursive: true, force: true }));

function put(path: string, contents: string) {
  const dest = join(repo, path);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, contents);
}

function commit() {
  git(repo, "add", ".");
  git(repo, "commit", "-m", "Fixture");
  return git(repo, "rev-parse", "HEAD").trim();
}

function makeRepo() {
  repo = mkdtempSync(join(tmpdir(), "edge-freeze-"));
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "Test Fixture");
  git(repo, "config", "user.email", "fixture@example.invalid");
  git(repo, "config", "commit.gpgsign", "false");
  put(fixture, wire);
  put(
    "apps/cli/src/client.ts",
    'client.call(api.messages.send); fetch("/cli/heartbeat");\n',
  );
  const base = commit();
  git(repo, "update-ref", "refs/remotes/origin/main", base);
  return base;
}

test("the first release freezes fixture bytes, inventory, revision and hashes", async () => {
  const revision = makeRepo();
  expect(releaseBaseline(repo, "")).toEqual([]);
  await freezeRelease(repo, "1.0.0", inventory);
  const release = join(repo, releasePath, "1.0.0");
  expect(await Bun.file(join(release, "hello.json")).text()).toBe(wire);
  expect(
    readClientInventory(
      await Bun.file(join(release, "client-inventory.txt")).text(),
    ),
  ).toEqual(["fn:messages:send", "http:POST /cli/heartbeat"]);
  expect(await Bun.file(join(release, "manifest.json")).json()).toEqual({
    revision,
    hashes: await fixtureHashes(release, [
      "hello.json",
      "client-inventory.txt",
    ]),
  });
  commit();
  await expect(freezeRelease(repo, "1.0.0", inventory)).rejects.toThrow(
    "EEXIST",
  );
});

test("freeze refuses untracked files before it writes a release", async () => {
  makeRepo();
  put("apps/server/convex/untracked.ts", "export const localOnly = 1;");
  await expect(freezeRelease(repo, "1.0.0", inventory)).rejects.toThrow(
    "no untracked files",
  );
  expect(releaseBaseline(repo, "")).toEqual([]);
});

test("a release appended by the candidate cannot replace the base release", async () => {
  makeRepo();
  await freezeRelease(repo, "1.0.0", inventory);
  const base = commit();
  git(repo, "update-ref", "refs/remotes/origin/main", base);
  await freezeRelease(repo, "2.0.0", inventory);
  commit();
  expect(releaseBaseline(repo, base)).toEqual(["1.0.0"]);
  put("notes.txt", "A later candidate commit.");
  commit();
  expect(releaseBaseline(repo, "")).toEqual(["1.0.0"]);
  for (const badBase of ["0".repeat(40), "f".repeat(40)]) {
    expect(releaseBaseline(repo, badBase)).toEqual(["1.0.0", "2.0.0"]);
  }
  put(`${releasePath}/1.0.0/hello.json`, "{}");
  expect(() => releaseBaseline(repo, base)).toThrow(
    "frozen release contents changed",
  );
});

test("the base guard rejects untracked additions inside an existing frozen release", async () => {
  makeRepo();
  await freezeRelease(repo, "1.0.0", inventory);
  const base = commit();
  put(`${releasePath}/1.0.0/added.json`, "{}");
  expect(() => releaseBaseline(repo, base)).toThrow("added.json");
});
