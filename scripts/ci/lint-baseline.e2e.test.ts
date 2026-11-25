import { expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { LINT_ROOT } from "../lib/oxlint";

function installLint(cwd: string) {
  for (const file of [
    ".oxlintrc.json",
    "scripts/lint.ts",
    "scripts/lib/lint-baseline.ts",
    "scripts/lib/oxlint.ts",
    "scripts/oxlint-plugin.mjs",
    "scripts/lib/semantic-comment.mjs",
  ]) {
    const target = join(cwd, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(LINT_ROOT, file), target);
  }
  mkdirSync(join(cwd, "node_modules/.bin"), { recursive: true });
  symlinkSync(
    join(LINT_ROOT, "node_modules/.bin/oxlint"),
    join(cwd, "node_modules/.bin/oxlint"),
  );
}

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(
    [
      "git",
      "-c",
      "user.name=Lint test",
      "-c",
      "user.email=lint@example.test",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function lint(cwd: string, args: string[] = [], base?: string) {
  const result = Bun.spawnSync([process.execPath, "scripts/lint.ts", ...args], {
    cwd,
    env: { ...process.env, LINT_BASE_SHA: base ?? "" },
  });
  return {
    code: result.exitCode,
    output: result.stdout.toString() + result.stderr.toString(),
  };
}

test("lint and prune transfer removed diagnostics one for one, including from a shallow Git base", async () => {
  const temp = mkdtempSync(join(tmpdir(), "swarm-lint-test-"));
  try {
    const cwd = join(temp, "repo");
    const source = "apps/web/source.ts";
    const destination = "apps/web/split.ts";
    const existing = "apps/web/existing.ts";
    const baselineName = "lint-baseline.json";
    const commentRule = "swarm/no-comments";
    const debuggerRule = "eslint/no-debugger";
    const originalBaseline = {
      [source]: { [commentRule]: 2, [debuggerRule]: 1 },
    };
    const moved = "/* café\n * retained text\n */";
    const split = "  /* café\n   * retained text\n   */\ndebugger;\n";
    const prefix = 'export const prefix = "é🙂";';
    const kept = "// stays in source";
    const keptCode =
      "export const value = 'Some source code stays with the renamed file.';\n";
    const shrunk = `${prefix}\n${kept}\n${keptCode}`;
    const put = (file: string, content: string) =>
      writeFileSync(join(cwd, file), content);

    mkdirSync(join(cwd, "apps/web"), { recursive: true });
    git(cwd, "init", "--initial-branch=main");
    put(source, `${prefix} ${moved}\n${kept}\n${keptCode}debugger;\n`);
    put(existing, "export const existing = true;\n");
    put(baselineName, JSON.stringify(originalBaseline));
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "Base");
    const base = git(cwd, "rev-parse", "HEAD");
    git(cwd, "update-ref", "refs/remotes/origin/main", base);
    git(cwd, "switch", "-c", "move");
    installLint(cwd);

    put(source, shrunk);
    for (const [label, content] of [
      ["new comment", split + "// newly written\n"],
      ["edited comment", split.replace("retained text", "edited text")],
      ["duplicate beyond the original count", split + moved + "\n"],
    ]) {
      put(destination, content);
      const result = lint(cwd);
      expect(result.code, label).toBe(1);
      expect(result.output, label).toContain(`${destination} [${commentRule}]`);
    }

    put(destination, split);
    put(source, `${prefix} ${moved}\n`);
    const copied = lint(cwd);
    expect(copied.code, "copied comment with another comment removed").toBe(1);
    expect(copied.output).toContain(
      `${destination} [${commentRule}]: 1 violations, baseline allows 0`,
    );

    put(
      source,
      `${prefix}\n// oxlint-disable-next-line ${commentRule}\n${moved}\n${kept}\n`,
    );
    const suppressed = lint(cwd);
    expect(suppressed.code, "copied comment still present but suppressed").toBe(
      1,
    );
    expect(suppressed.output).toContain(`${destination} [${commentRule}]`);

    rmSync(join(cwd, destination));
    put(source, shrunk);
    put(existing, split);
    const grewExisting = lint(cwd);
    expect(grewExisting.code, "existing path gains diagnostics").toBe(1);
    expect(grewExisting.output).toContain(`${existing} [${commentRule}]`);
    put(existing, "export const existing = true;\n");

    put(destination, split);
    const movedResult = lint(cwd);
    expect(movedResult.code, movedResult.output).toBe(0);
    const prune = lint(cwd, ["--prune"]);
    expect(prune.code, prune.output).toBe(0);
    const saved = {
      [source]: { [commentRule]: 1 },
      [destination]: { [debuggerRule]: 1, [commentRule]: 1 },
    };
    expect(await Bun.file(join(cwd, baselineName)).json()).toEqual(saved);
    git(cwd, "add", source, destination, baselineName);
    git(cwd, "commit", "-m", "Move diagnostics");

    const shallow = join(temp, "shallow");
    git(cwd, "config", "uploadpack.allowFilter", "true");
    git(
      temp,
      "clone",
      "--depth=1",
      "--filter=blob:none",
      "--branch=move",
      pathToFileURL(cwd).href,
      shallow,
    );
    git(shallow, "fetch", "--depth=1", "origin", base);
    expect(git(shallow, "rev-parse", "--is-shallow-repository")).toBe("true");
    expect(git(shallow, "rev-list", "--count", "HEAD")).toBe("1");
    installLint(shallow);
    const accepted = lint(shallow, [], base);
    expect(accepted.code, accepted.output).toBe(0);

    const shallowBaseline = join(shallow, baselineName);
    writeFileSync(shallowBaseline, JSON.stringify(originalBaseline));
    const shallowPrune = lint(shallow, ["--prune"], base);
    expect(shallowPrune.code, shallowPrune.output).toBe(0);
    expect(await Bun.file(shallowBaseline).json()).toEqual(saved);

    writeFileSync(
      shallowBaseline,
      JSON.stringify({
        ...saved,
        [source]: { [commentRule]: 2 },
      }),
    );
    const doubleSpent = lint(shallow, [], base);
    expect(
      doubleSpent.code,
      "retained allowance plus transferred allowance",
    ).toBe(1);
    expect(doubleSpent.output).toContain(
      `Baseline grew for ${destination} [${commentRule}]`,
    );

    writeFileSync(
      shallowBaseline,
      JSON.stringify({
        ...saved,
        [existing]: { [commentRule]: 1 },
      }),
    );
    const inflated = lint(shallow, [], base);
    expect(inflated.code, "saved allowance grows for an existing path").toBe(1);
    expect(inflated.output).toContain(
      `Baseline grew for ${existing} [${commentRule}]`,
    );

    const renamed = "apps/web/renamed-source.ts";
    git(cwd, "switch", "-c", "rename-and-split", "main");
    git(cwd, "mv", source, renamed);
    put(renamed, shrunk);
    put(destination, split);
    git(cwd, "add", renamed, destination);
    expect(git(cwd, "diff", "--name-status", "--find-renames", base)).toMatch(
      new RegExp(`^R\\d+\\t${source}\\t${renamed}$`, "m"),
    );
    const renamedPrune = lint(cwd, ["--prune"]);
    expect(renamedPrune.code, `rename and split: ${renamedPrune.output}`).toBe(
      0,
    );
    expect(await Bun.file(join(cwd, baselineName)).json()).toEqual({
      [renamed]: { [commentRule]: 1 },
      [destination]: saved[destination],
    });
    const renamedCheck = lint(cwd, [], base);
    expect(renamedCheck.code, renamedCheck.output).toBe(0);

    put(destination, "debugger;\n");
    const prunedAgain = lint(cwd, ["--prune"]);
    expect(
      prunedAgain.code,
      `remove a previously transferred diagnostic: ${prunedAgain.output}`,
    ).toBe(0);
    expect(await Bun.file(join(cwd, baselineName)).json()).toEqual({
      [renamed]: { [commentRule]: 1 },
      [destination]: { [debuggerRule]: 1 },
    });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}, 30_000);
