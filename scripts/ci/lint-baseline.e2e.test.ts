import { expect, test } from "bun:test";
import {
  chmodSync,
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
    "scripts/lib/effect-import-rule.mjs",
    "scripts/lib/effect-zone.mjs",
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
    const source = "apps/web/Source.ts";
    const destination = "apps/web/split.ts";
    const existing = "apps/web/existing.ts";
    const baselineName = "lint-baseline.json";
    const commentRule = "swarm/no-comments";
    const debuggerRule = "eslint/no-debugger";
    const originalBaseline = {
      [source]: { [commentRule]: 3, [debuggerRule]: 1 },
    };
    const moved = "/* café\n * retained text\n */";
    const prefix = 'var prefix = "é🙂";';
    const anchor = "var movedAnchor = true;";
    const tail = "var debuggerAnchor = true;";
    const movedBlock = `${prefix} ${moved}\n${anchor}\n// another explanatory note\ndebugger;\n${tail}\n`;
    const split = movedBlock
      .split("\n")
      .map((line) => "  " + line)
      .join("\n");
    const kept = "// stays in source";
    const keptCode =
      "export const value = 'Some source code stays with the renamed file.';\n" +
      "export const more = 'Enough code stays to prove that Git detects the rename.';\n";
    const shrunk = `${kept}\n${keptCode}`;
    const put = (file: string, content: string) =>
      writeFileSync(join(cwd, file), content);

    mkdirSync(join(cwd, "apps/web"), { recursive: true });
    git(cwd, "init", "--initial-branch=main");
    put(source, movedBlock + shrunk);
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
      ["duplicate beyond the original count", split + movedBlock],
    ]) {
      put(destination, content);
      const result = lint(cwd);
      expect(result.code, label).toBe(1);
      expect(result.output, label).toContain(`${destination} [${commentRule}]`);
    }

    put(destination, split);
    put(source, `${prefix} ${moved}\n${anchor}\n`);
    const copied = lint(cwd);
    expect(copied.code, "copied comment with another comment removed").toBe(1);
    expect(copied.output).toContain(
      `${destination} [${commentRule}]: 2 violations, baseline allows 1`,
    );

    put(
      source,
      `// oxlint-disable-next-line ${commentRule}\n${prefix} ${moved}\n${anchor}\n${kept}\n`,
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
    for (const sha of [undefined, base]) {
      for (const count of [0, 1, 3]) {
        put(
          baselineName,
          JSON.stringify({
            [source]: { [commentRule]: 1 },
            ...(count
              ? { [destination]: { [commentRule]: count, [debuggerRule]: 1 } }
              : {}),
          }),
        );
        const mismatch = lint(cwd, [], sha);
        expect(
          mismatch.code,
          `unrecorded or mismatched transfer ${count}`,
        ).toBe(1);
        expect(mismatch.output).toContain("bun run lint:prune");
      }
    }
    put(baselineName, JSON.stringify(originalBaseline));
    const prune = lint(cwd, ["--prune"]);
    expect(prune.code, prune.output).toBe(0);
    const saved = {
      [source]: { [commentRule]: 1 },
      [destination]: { [debuggerRule]: 1, [commentRule]: 2 },
    };
    expect(await Bun.file(join(cwd, baselineName)).json()).toEqual(saved);
    const recorded = lint(cwd);
    expect(recorded.code, recorded.output).toBe(0);
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
      `Baseline counts do not match the transfer for ${destination} [${commentRule}]`,
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

    const renamed = "apps/web/source.ts";
    git(cwd, "switch", "-c", "rename-and-split", "main");
    git(cwd, "mv", source, renamed);
    put(renamed, shrunk);
    put(destination, split);
    git(cwd, "add", renamed, destination);
    expect(git(cwd, "diff", "--name-status", "--find-renames", base)).toMatch(
      new RegExp(`^R\\d+\\t${source}\\t${renamed}$`, "m"),
    );
    put(baselineName, JSON.stringify(saved));
    const stale = lint(cwd);
    expect(stale.code, stale.output).toBe(1);
    expect(stale.output).toContain(
      `lint-baseline.json names ${source}, which no longer exists.`,
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

    put(destination, `${anchor}\ndebugger;\n${tail}\n`);
    for (const sha of [undefined, base]) {
      put(
        baselineName,
        JSON.stringify({
          [renamed]: saved[source],
          [destination]: saved[destination],
        }),
      );
      const unpruned = lint(cwd, [], sha);
      expect(unpruned.code).toBe(1);
      expect(unpruned.output).toContain("bun run lint:prune");
      const prunedAgain = lint(cwd, ["--prune"], sha);
      expect(
        prunedAgain.code,
        `remove a previously transferred diagnostic: ${prunedAgain.output}`,
      ).toBe(0);
      expect(await Bun.file(join(cwd, baselineName)).json()).toEqual({
        [renamed]: { [commentRule]: 1 },
        [destination]: { [debuggerRule]: 1 },
      });
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}, 30_000);

test("rejects unrelated diagnostics after deletion of their former source", () => {
  const cwd = mkdtempSync(join(tmpdir(), "swarm-lint-deleted-"));
  try {
    const donor = "apps/web/former.ts";
    const destination = "apps/web/unrelated.ts";
    const keeper = "export const shared = true;\n";
    const cases = [
      [
        "no-blocking-child-process-call",
        'execSync("old");',
        'execSync("new");',
      ],
      [
        "no-raw-child-process",
        'import old from "node:child_process";',
        'import replacement from "node:child_process";',
      ],
      [
        "no-raw-resize-observer",
        "new ResizeObserver(old);",
        "new ResizeObserver(replacement);",
      ],
      [
        "ime-safe-key-handlers",
        'if (e.key === "Enter") old();',
        'if (e.key === "Enter") replacement();',
      ],
      ["no-comments", "// TODO", "// TODO"],
    ] as const;
    const baseline = Object.fromEntries(
      cases.map(([rule]) => [`swarm/${rule}`, 1]),
    );
    mkdirSync(join(cwd, "apps/web"), { recursive: true });
    git(cwd, "init", "--initial-branch=main");
    writeFileSync(
      join(cwd, donor),
      cases
        .map(
          ([, line]) =>
            `${keeper.replace("shared", "before" + line.length)}${line}\n`,
        )
        .join(""),
    );
    writeFileSync(
      join(cwd, "lint-baseline.json"),
      JSON.stringify({ [donor]: baseline }),
    );
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "Base");
    installLint(cwd);
    const base = git(cwd, "rev-parse", "HEAD");
    rmSync(join(cwd, donor));
    const rejectedRules: string[] = [];
    for (const [rule, original, replacement] of cases) {
      const previous = keeper.replace("shared", "before" + original.length);
      const contents =
        rule === "no-comments"
          ? [`\n${replacement}\n`, `${keeper}${replacement}\n`]
          : [previous + replacement + "\n"];
      const results = contents.map((content) => {
        writeFileSync(join(cwd, destination), content);
        return lint(cwd, ["--prune"], base);
      });
      if (
        results.every(
          ({ code, output }) =>
            code === 1 && output.includes(`${destination} [swarm/${rule}]`),
        )
      )
        rejectedRules.push(rule);
    }
    expect(rejectedRules).toEqual(cases.map(([rule]) => rule));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 20_000);

test("checks whole-line removal and rescans only changed donors", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "swarm-lint-donors-"));
  try {
    const donor = "apps/web/former.ts";
    const unchanged = "apps/web/unchanged.ts";
    const destination = "apps/web/moved.ts";
    const anchor = "export const anchor = true;\n";
    const commentRule = "swarm/no-comments";
    mkdirSync(join(cwd, "apps/web"), { recursive: true });
    git(cwd, "init", "--initial-branch=main");
    writeFileSync(
      join(cwd, donor),
      `// TODO\n${anchor}// another old comment\n`,
    );
    writeFileSync(join(cwd, unchanged), `// TODO\n${anchor}`);
    writeFileSync(
      join(cwd, "lint-baseline.json"),
      JSON.stringify({
        [donor]: { [commentRule]: 2 },
        [unchanged]: { [commentRule]: 1 },
      }),
    );
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "Base");
    installLint(cwd);
    const base = git(cwd, "rev-parse", "HEAD");
    writeFileSync(join(cwd, donor), "// prefix // TODO\n");
    writeFileSync(join(cwd, destination), `// TODO\n${anchor}`);

    const executable = join(cwd, "node_modules/.bin/oxlint");
    const scanLog = join(cwd, "base-scan.json");
    rmSync(executable);
    writeFileSync(
      executable,
      `#!${process.execPath}
const args = process.argv.slice(2);
const separator = args.indexOf("--");
if (separator !== -1) await Bun.write(${JSON.stringify(scanLog)}, JSON.stringify(args.slice(separator + 1)));
else args.push("--ignore-pattern", ${JSON.stringify(unchanged)});
const run = Bun.spawnSync([${JSON.stringify(join(LINT_ROOT, "node_modules/.bin/oxlint"))}, ...args], { stdout: "inherit", stderr: "inherit" });
process.exit(run.exitCode);
`,
    );
    chmodSync(executable, 0o755);
    const pruned = lint(cwd, ["--prune"], base);
    expect(pruned.code, pruned.output).toBe(0);
    expect(await Bun.file(scanLog).json()).toEqual([donor]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 20_000);

test("compares with the fork point when the base moved ahead", () => {
  const cwd = mkdtempSync(join(tmpdir(), "swarm-lint-ahead-"));
  try {
    const file = "apps/web/other.ts";
    const save = (count: number) => {
      writeFileSync(join(cwd, file), "// old comment\n".repeat(count));
      writeFileSync(
        join(cwd, "lint-baseline.json"),
        JSON.stringify({ [file]: { "swarm/no-comments": count } }),
      );
      git(cwd, "add", ".");
      git(cwd, "commit", "-m", `${count} comments`);
    };
    mkdirSync(join(cwd, "apps/web"), { recursive: true });
    git(cwd, "init", "--initial-branch=main");
    save(2);
    git(cwd, "switch", "-c", "change");
    git(cwd, "switch", "main");
    save(1);
    const ahead = git(cwd, "rev-parse", "HEAD");
    git(cwd, "switch", "change");
    installLint(cwd);
    const result = lint(cwd, [], ahead);
    expect(result.code, result.output).toBe(0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
