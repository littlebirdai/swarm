import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export function workspaceDirectories(root: string, group: string): string[] {
  const directory = join(root, group);
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.name.startsWith(".") &&
        entry.name !== "node_modules",
    )
    .map((entry) => join(group, entry.name))
    .sort();
}

type ExportTarget = string | null | { [condition: string]: ExportTarget };

type Workspace = {
  dir: string;
  main?: string;
  exports?: ExportTarget;
};

export function readWorkspaces(root: string, directories: string[]) {
  const workspaces = new Map<string, Workspace>();
  for (const directory of directories) {
    const dir = resolve(root, directory);
    const manifest = join(dir, "package.json");
    if (!existsSync(manifest)) continue;
    const { name, main, exports } = JSON.parse(readFileSync(manifest, "utf8"));
    if (typeof name === "string") workspaces.set(name, { dir, main, exports });
  }
  return workspaces;
}

function importTarget(target: ExportTarget | undefined): string | null {
  if (typeof target === "string") return target;
  if (!target) return null;
  for (const [condition, value] of Object.entries(target)) {
    if (["bun", "node", "import", "default"].includes(condition)) {
      const path = importTarget(value);
      if (path !== null || value === null) return path;
    }
  }
  return null;
}

function exportTarget(exports: ExportTarget, subpath: string): string | null {
  if (!exports || typeof exports === "string") {
    return subpath === "." ? exports : null;
  }
  if (!Object.keys(exports).some((key) => key.startsWith("."))) {
    return subpath === "." ? importTarget(exports) : null;
  }
  if (Object.hasOwn(exports, subpath)) return importTarget(exports[subpath]);

  const patterns = Object.keys(exports)
    .filter((key) => key.includes("*"))
    .sort((a, b) => b.indexOf("*") - a.indexOf("*") || b.length - a.length);
  for (const pattern of patterns) {
    const [prefix, suffix] = pattern.split("*");
    if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
    if (subpath.length < prefix.length + suffix.length) continue;
    const match = subpath.slice(prefix.length, subpath.length - suffix.length);
    return importTarget(exports[pattern])?.replaceAll("*", match) ?? null;
  }
  return null;
}

export function workspaceImport(
  workspaces: ReadonlyMap<string, Workspace>,
  spec: string,
): { dir: string; target: string | null } | null {
  const name = spec
    .split("/")
    .slice(0, spec.startsWith("@") ? 2 : 1)
    .join("/");
  const workspace = workspaces.get(name);
  if (!workspace) return null;
  const subpath = spec === name ? "." : `.${spec.slice(name.length)}`;
  const target =
    workspace.exports === undefined
      ? subpath === "."
        ? (workspace.main ?? "./index")
        : subpath
      : exportTarget(workspace.exports, subpath);
  return {
    dir: workspace.dir,
    target: target ? join(workspace.dir, target) : null,
  };
}

export function createLibraryResolver(root: string) {
  const libraries = readWorkspaces(
    root,
    workspaceDirectories(root, "packages"),
  );
  return (spec: string): string | null =>
    spec.startsWith("@codecast/")
      ? (workspaceImport(libraries, spec)?.target ?? null)
      : null;
}
