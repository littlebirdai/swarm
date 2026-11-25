import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runTreeChild } from "../../apps/server/scripts/prod-diff";

export const root = join(import.meta.dir, "../..");
export const releasePath = "packages/edge-contract/test/releases";

export function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd });
  if (!result.success) throw new Error(result.stderr.toString().trim());
  return result.stdout.toString();
}

export function releaseBaseline(repo: string, requested: string | undefined) {
  const readGit = (...args: string[]) => git(repo, ...args).trim();
  let base: string;
  try {
    if (!requested) base = readGit("merge-base", "HEAD", "origin/main");
    else {
      if (!/^[a-f0-9]{40}$/.test(requested)) throw new Error("invalid base");
      base = readGit("rev-parse", "--verify", `${requested}^{commit}`);
    }
  } catch {
    base = readGit("rev-parse", "--verify", "HEAD~1");
  }
  if (!base) base = readGit("rev-parse", "--verify", "HEAD~1");
  const paths = readGit("ls-tree", "-d", "--name-only", base, `${releasePath}/`)
    .split("\n")
    .filter(Boolean);
  const changed =
    paths.length > 0 &&
    (readGit("diff", "--name-only", base, "--", ...paths) ||
      readGit("ls-files", "--others", "--exclude-standard", "--", ...paths));
  if (changed) throw new Error(`frozen release contents changed:\n${changed}`);
  return paths
    .map((path) => path.slice(releasePath.length + 1))
    .sort(Bun.semver.order);
}

export async function fixtureHashes(dir: string, files: string[]) {
  const entries = await Promise.all(
    files
      .sort()
      .map(async (file) => [
        file,
        new Bun.CryptoHasher("sha256")
          .update(await readFile(join(dir, file)))
          .digest("hex"),
      ]),
  );
  return Object.fromEntries(entries);
}

function clientInventory(names: string[], source: string): string[] {
  const refs = new Set<string>();
  for (const [match, dotted] of source.matchAll(
    /\bapi\.([\w.]+)|\b[\w/]+:[a-zA-Z_$][\w$]*\b/g,
  )) {
    if (!dotted) {
      refs.add(match);
      continue;
    }
    const parts = dotted.split(".");
    while (parts.length > 1) {
      const name = parts.pop();
      refs.add(`${parts.join("/")}:${name}`);
    }
  }
  return names
    .filter((name) => {
      if (name.startsWith("fn:")) return refs.has(name.slice(3));
      const path = name.slice(name.indexOf(" ") + 1).replace(/\*$/, "");
      return source.includes(path);
    })
    .sort();
}

export function readClientInventory(text: string): string[] {
  return text
    .trim()
    .split("\n")
    .flatMap((line) => {
      const [prefix, ...names] = line.split("\t");
      return names.map((name) => prefix + name);
    });
}

export async function freezeRelease(
  repo: string,
  version: string | undefined,
  inventory: () => Promise<string[]>,
) {
  if (!version || !/^\d+\.\d+\.\d+(?:-[a-z0-9-]+)?$/.test(version))
    throw new Error(
      "usage: bun scripts/ci/freeze-edge-contract.ts <release-version>",
    );
  const revision = git(repo, "rev-parse", "HEAD").trim();
  const fixtures = "packages/edge-contract/test/fixtures";
  const sources = ["apps/cli/src", "apps/web", "apps/mobile", "packages"];
  if (git(repo, "status", "--porcelain", "--untracked-files=all"))
    throw new Error(
      "freeze the release from a clean checkout with no untracked files",
    );
  const files = git(repo, "ls-tree", "--name-only", revision, `${fixtures}/`)
    .trim()
    .split("\n");
  const sourceFiles = git(repo, "ls-files", "-z", "--", ...sources)
    .split("\0")
    .filter(
      (file) =>
        /\.tsx?$/.test(file) &&
        !/\.(?:test|testkit|fixture)\./.test(file) &&
        !/\/(?:__tests__|__fixtures__|test|e2e)\//.test(file),
    );
  const chunks = [];
  for (const file of sourceFiles)
    chunks.push(await readFile(join(repo, file), "utf8"));
  const source = chunks.join("\n");
  const references = clientInventory(await inventory(), source);
  if (
    !references.some((name) => name.startsWith("fn:")) ||
    !references.some((name) => name.startsWith("http:"))
  ) {
    throw new Error(
      "expected both function and HTTP references in the release",
    );
  }
  const dir = join(repo, releasePath, version);
  await mkdir(join(repo, releasePath), { recursive: true });
  await mkdir(dir);
  for (const path of files) {
    await writeFile(
      join(dir, path.slice(fixtures.length + 1)),
      git(repo, "show", `${revision}:${path}`),
    );
  }
  const groups = Map.groupBy(references, (name) => {
    const end = name.startsWith("fn:")
      ? name.lastIndexOf(":") + 1
      : (name.match(/^http:\w+ (?:\/[^/]+){0,2}\//)?.[0].length ??
        name.indexOf(" ") + 1);
    return name.slice(0, end);
  });
  const clientNames = [...groups].map(([prefix, names]) =>
    [prefix, ...names.map((name) => name.slice(prefix.length))].join("\t"),
  );
  await writeFile(
    join(dir, "client-inventory.txt"),
    clientNames.join("\n") + "\n",
  );
  const hashes = await fixtureHashes(dir, await readdir(dir));
  await writeFile(
    join(dir, "manifest.json"),
    JSON.stringify({ revision, hashes }, null, 2) + "\n",
  );
}

if (import.meta.main)
  await freezeRelease(root, process.argv[2], () => runTreeChild("public"));
