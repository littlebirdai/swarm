import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { workspaceDirectories } from "../workspace-packages";

const TEST_FILE = /[._](test|spec)\.[cm]?[jt]sx?$/;

export function testFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") testFiles(full, out);
    } else if (TEST_FILE.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

export function packageTestDirectories(root: string): string[] {
  return workspaceDirectories(root, "packages").filter(
    (dir) => testFiles(join(root, dir)).length > 0,
  );
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..", "..");
  const failed: string[] = [];
  for (const dir of packageTestDirectories(root)) {
    const cwd = join(root, dir);
    console.log(`::group::${dir}`);
    const proc = Bun.spawn(["bun", "test"], {
      cwd,
      stdio: ["inherit", "inherit", "inherit"],
    });
    if ((await proc.exited) !== 0) failed.push(dir);
    console.log("::endgroup::");
  }
  if (failed.length > 0) {
    console.error(`::error::Tests failed in ${failed.join(", ")}`);
    process.exitCode = 1;
  }
}
