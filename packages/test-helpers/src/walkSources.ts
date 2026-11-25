import { readdirSync } from "node:fs";
import { join } from "node:path";

export function walkSources(
  dir: string,
  skipDirs: ReadonlySet<string>,
  include: (name: string) => boolean = (name) =>
    name.endsWith(".ts") && !name.endsWith(".test.ts"),
  out: string[] = [],
): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) walkSources(file, skipDirs, include, out);
    } else if (include(entry.name)) {
      out.push(file);
    }
  }
  return out;
}
