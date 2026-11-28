import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

function collectTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectTsFiles(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry))
      out.push(full);
  }
  return out;
}

test("every installOpfsSAHPoolVfs call sets preserveOnInitFailure: true", () => {
  const persistenceDir = resolve(import.meta.dir, "..");
  const files = collectTsFiles(persistenceDir);
  let callCount = 0;
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const matches = source.matchAll(
      /installOpfsSAHPoolVfs\s*\(\s*\{([\s\S]*?)\}\s*\)/g,
    );
    for (const match of matches) {
      callCount++;
      expect(match[1]).toMatch(/\bpreserveOnInitFailure\s*:\s*true\b/);
    }
    if (source.includes("installOpfsSAHPoolVfs")) {
      expect(source).toMatch(/\bpreserveOnInitFailure\s*:\s*true\b/);
    }
  }
  expect(callCount).toBeGreaterThan(0);
});
