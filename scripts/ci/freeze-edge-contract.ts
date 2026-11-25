import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runTreeChild } from "../../apps/server/scripts/prod-diff";

export const root = join(import.meta.dir, "../..");
export const releasePath = "packages/edge-contract/test/releases";

export function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: root });
  if (!result.success) throw new Error(result.stderr.toString().trim());
  return result.stdout.toString();
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

if (import.meta.main) {
  const [version] = process.argv.slice(2);
  if (!version || !/^\d+\.\d+\.\d+(?:-[a-z0-9-]+)?$/.test(version))
    throw new Error(
      "usage: bun scripts/ci/freeze-edge-contract.ts <release-version>",
    );
  const revision = git("rev-parse", "HEAD").trim();
  const fixtures = "packages/edge-contract/test/fixtures";
  const sources = ["apps/cli/src", "apps/web", "apps/mobile", "packages"];
  git("diff", "--exit-code", "HEAD", "--", "apps/server/convex", ...sources);
  const files = git("ls-tree", "--name-only", revision, `${fixtures}/`)
    .trim()
    .split("\n");
  const sourceFiles = git("ls-files", "-z", "--", ...sources)
    .split("\0")
    .filter(
      (file) =>
        /\.tsx?$/.test(file) &&
        !/\.(?:test|testkit|fixture)\./.test(file) &&
        !/\/(?:__tests__|__fixtures__|test|e2e)\//.test(file),
    );
  const chunks = [];
  for (const file of sourceFiles)
    chunks.push(await readFile(join(root, file), "utf8"));
  const source = chunks.join("\n");
  const inventory = clientInventory(await runTreeChild("public"), source);
  if (
    !inventory.some((name) => name.startsWith("fn:")) ||
    !inventory.some((name) => name.startsWith("http:"))
  ) {
    throw new Error(
      "expected both function and HTTP references in the release",
    );
  }
  const dir = join(root, releasePath, version);
  await mkdir(join(root, releasePath), { recursive: true });
  await mkdir(dir);
  for (const path of files) {
    await writeFile(
      join(dir, path.slice(fixtures.length + 1)),
      git("show", `${revision}:${path}`),
    );
  }
  const groups = Map.groupBy(inventory, (name) => {
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
