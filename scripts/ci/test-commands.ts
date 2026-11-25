import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export const ROOT = join(import.meta.dir, "../..");
export const TEST_FILE = /[._](test|spec)\.[cm]?[jt]sx?$/;

type Command =
  | { runner: "bun" | "node"; args: string[] }
  | { runner: "always" | "packages" | "platform" };
type BunConfig = { root?: string; pathIgnorePatterns?: string[] };

const RUNNER =
  /\b(?:bun\s+(?:run\s+)?test\b|node\b[^\n]*\s--test\b|(?:bunx|npx|pnpm|npm|yarn|pnpx)\s+(?:run\s+)?test\b|(?:vitest|jest|mocha|playwright|pytest)\b|swift\s+test\b|scripts\/ci\/(?:always-run-tests|package-tests)\.ts\b|vendor-platform\.sh\s+--test\b)/;

const ECHO = /^echo(?:\s+(?:'[^']*'|"[^"$`\\]*"|[\w.:/+@=%*-]+))*$/;

export function namesTestRunner(run: string): boolean {
  return run.split("\n").some((line) => {
    const command = line.trim();
    return (
      !command.startsWith("#") && !ECHO.test(command) && RUNNER.test(command)
    );
  });
}

function fail(command: string): never {
  throw new Error(`Unsupported CI test command: ${command}`);
}

function words(command: string): string[] {
  const token = /(?:[\w./=:+*,?@-]+|'[\w./=:+*,?@ -]*'|"[\w./=:+*,?@ -]*")+/y;
  const result: string[] = [];
  for (let index = 0; index < command.length;) {
    token.lastIndex = index;
    const match = token.exec(command);
    if (!match) fail(command);
    result.push(match[0].replace(/['"]/g, ""));
    index = token.lastIndex;
    if (index < command.length && !/\s/.test(command[index])) fail(command);
    while (index < command.length && /\s/.test(command[index])) index++;
  }
  return result;
}

const BUN_FLAG =
  /^--(?:isolate|parallel(?:=\d+)?|(?:timeout|bail|retry)=\d+|timings=[\w./-]+|shard=\d+\/\d+|path-ignore-patterns=[^\n]*)$/;

export function parseTestCommands(
  run: string,
  dir: string,
  entry: Record<string, string | number | boolean> = {},
  root = ROOT,
): Command[] {
  run = run.replace(/\\\r?\n/g, " ");
  if (!namesTestRunner(run)) return [];
  return run.split("\n").flatMap((line): Command[] => {
    const command = line.trim();
    if (!command || command.startsWith("#")) return [];
    if (ECHO.test(command)) return [];
    if (command === "swift test") return [];
    if (command === "bun scripts/ci/always-run-tests.ts")
      return [{ runner: "always" }];
    if (command === "bun scripts/ci/package-tests.ts")
      return [{ runner: "packages" }];
    if (command === "scripts/vendor-platform.sh --test")
      return [{ runner: "platform" }];
    const expanded = command
      .replace(/\$\{\{\s*matrix\.(\w+)\s*\}\}/g, (_, key) =>
        String(entry[key] ?? ""),
      )
      .replace(
        /\$\{SUITE#tmux-\}/g,
        String(entry.suite ?? "").replace(/^tmux-/, ""),
      );
    const plain = expanded.replace(
      /^(?:bash \.\.\/\.\.\/scripts\/ci\/(?:quiet-watchdog\.sh \d+ --|retry-tests\.sh)|xvfb-run -a) /,
      "",
    );
    const [runner, verb, ...args] = words(plain);
    if (runner === "bun" && verb === "test") {
      if (args.some((arg) => arg.startsWith("-") && !BUN_FLAG.test(arg)))
        fail(command);
      return [{ runner: "bun", args }];
    }
    if (
      runner === "node" &&
      verb === "--test" &&
      args.length &&
      args.every((arg) => !arg.startsWith("-"))
    ) {
      return [{ runner: "node", args }];
    }
    const script = verb === "run" ? args[0] : verb;
    if (
      runner === "bun" &&
      /^test(?::[\w-]+)?$/.test(script ?? "") &&
      args.length === Number(verb === "run")
    ) {
      const pkg = JSON.parse(
        readFileSync(join(root, dir, "package.json"), "utf8"),
      );
      const body = pkg.scripts?.[script];
      if (
        typeof body !== "string" ||
        !/^(bun test|node --test)(?:\s|$)/.test(body)
      )
        fail(command);
      return parseTestCommands(body, dir, entry, root);
    }
    return fail(command);
  });
}

function within(base: string, file: string): boolean {
  const path = relative(base, file);
  return path !== ".." && !path.startsWith("../");
}

export function bunFiles(
  dir: string,
  args: string[],
  files: string[],
  root = ROOT,
): string[] {
  const cwd = resolve(root, dir);
  const configPath = join(cwd, "bunfig.toml");
  const config = existsSync(configPath)
    ? (Bun.TOML.parse(readFileSync(configPath, "utf8")) as { test?: BunConfig })
        .test
    : undefined;
  const testRoot = resolve(cwd, config?.root ?? ".");
  const ignorePrefix = "--path-ignore-patterns=";
  const overrides = args.filter((arg) => arg.startsWith(ignorePrefix));
  const ignores = (
    overrides.length
      ? overrides.map((arg) => arg.slice(ignorePrefix.length))
      : (config?.pathIgnorePatterns ?? [])
  )
    .filter(Boolean)
    .map((pattern) => new Bun.Glob(pattern));
  const filters = args.filter((arg) => !arg.startsWith("-"));
  const direct = filters
    .filter((filter) => filter.startsWith("./"))
    .map((filter) => ({
      path: resolve(cwd, filter),
      file: TEST_FILE.test(filter),
    }));
  const substrings = filters.filter((filter) => !filter.startsWith("./"));
  return files.filter((file) => {
    const path = resolve(root, file);
    if (ignores.some((glob) => glob.match(path))) return false;
    if (direct.some((filter) => filter.file && filter.path === path))
      return true;
    const roots = [
      ...(!filters.length || substrings.some((filter) => path.includes(filter))
        ? [testRoot]
        : []),
      ...direct.filter((filter) => !filter.file).map((filter) => filter.path),
    ];
    return roots.some(
      (base) =>
        within(base, path) &&
        !relative(base, path)
          .split("/")
          .slice(0, -1)
          .some((part) => part.startsWith(".") || part === "node_modules"),
    );
  });
}

export function filesForCommand(
  command: Command,
  dir: string,
  files: string[],
  root = ROOT,
): string[] {
  if (command.runner === "bun") return bunFiles(dir, command.args, files, root);
  if (command.runner === "node") {
    const globs = command.args.map(
      (pattern) => new Bun.Glob(pattern.replace(/^\.\//, "")),
    );
    return files.filter(
      (file) =>
        within(dir, file) &&
        globs.some((glob) => glob.match(relative(dir, file))),
    );
  }
  throw new Error(`No file selector for ${command.runner}`);
}
