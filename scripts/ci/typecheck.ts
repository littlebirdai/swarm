import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

export const LOCAL_ONLY_PROGRAMS = ["mobile"];

export async function typecheckPrograms(): Promise<Record<string, string>> {
  const config = Bun.TOML.parse(
    await Bun.file(join(ROOT, ".codecast/check.toml")).text(),
  ) as { projects: Record<string, string> };
  return Object.fromEntries(
    Object.entries(config.projects).filter(
      ([name]) => !LOCAL_ONLY_PROGRAMS.includes(name),
    ),
  );
}

if (import.meta.main) {
  const programs = await typecheckPrograms();
  const names = process.argv.slice(2);
  if (names.length === 0) names.push(...Object.keys(programs));
  const unknown = names.filter((name) => !Object.hasOwn(programs, name));
  if (unknown.length > 0) {
    console.error(`::error::Unknown typecheck programs: ${unknown.join(", ")}`);
    process.exit(1);
  }
  const failed: string[] = [];
  await Promise.all(
    names.map(async (name) => {
      const started = performance.now();
      const proc = Bun.spawn(
        [
          join(ROOT, "node_modules/.bin/tsgo"),
          "--noEmit",
          "--checkers",
          "1",
          "-p",
          programs[name],
        ],
        { cwd: ROOT, stdio: ["inherit", "inherit", "inherit"] },
      );
      const code = await proc.exited;
      const seconds = Math.round((performance.now() - started) / 1000);
      console.log(`${name}: exit ${code} in ${seconds}s`);
      if (code !== 0) failed.push(name);
    }),
  );
  if (failed.length > 0) {
    console.error(`::error::Typecheck failed in ${failed.join(", ")}`);
    process.exit(1);
  }
}
