import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  LINT_ROOT,
  lintLocation,
  oxlintCommand,
  parseOxlintReport,
} from "../../../scripts/lib/oxlint";

test("Oxlint enforces Effect zones, including indirect imports", async () => {
  const plain = mkdtempSync(join(tmpdir(), "effect-lint-"));
  const zone = mkdtempSync(join(LINT_ROOT, "packages/effect-kit/test/.lint-"));
  try {
    const outside = join(plain, "outside.ts");
    const allowed = join(zone, "allowed.ts");
    const inside = join(zone, "inside.ts");
    const relativeImport = relative(
      plain,
      join(LINT_ROOT, "packages/effect-kit/src/index.ts"),
    );
    writeFileSync(
      outside,
      [
        'import { sleep } from "effect/Effect";',
        'import "@codecast/edge-client/effect";',
        'import "@codecast/effect-kit";',
        'export * from "@codecast/effect-kit/effect/testing";',
        'type T = import("effect/Effect").Effect<void>;',
        "void import(`effect/Effect`);",
        'import Factory = require("effect/Clock");',
        'import { createRequire as factory } from "node:module";',
        'factory(import.meta.url)("effect/Effect");',
        "const request = factory(import.meta.url);",
        "const alias = request;",
        'alias.resolve("effect/Effect");',
        'globalThis.require("effect/Effect");',
        '(require)("effect/Effect");',
        'module["require"]("effect/Effect");',
        'require.resolve("effect/Effect");',
        `import "${relativeImport}";`,
        'import "../does-not-exist";',
        'const text = "effect/Effect";',
        'fetch("effect/Effect");',
        'import "@codecast/effect-kit/private";',
        '(require as NodeRequire)("effect/Effect");',
        '(<NodeRequire>require)("effect/Effect");',
        'require!("effect/Effect");',
        '(require satisfies NodeRequire)("effect/Effect");',
        'import.meta.resolve("effect/Effect");',
        'Bun.resolveSync("effect/Effect", ".");',
      ].join("\n"),
    );
    writeFileSync(
      inside,
      [
        'import { Effect } from "effect";',
        'createRequire(import.meta.url)("effect/Effect");',
        'import EffectModule = require("effect/Effect");',
        'import.meta.resolve("effect");',
        'Bun.resolveSync("effect", ".");',
      ].join("\n"),
    );
    writeFileSync(
      allowed,
      'import { sleep } from "effect/Effect";\nimport { it } from "@codecast/effect-kit/effect/testing";\n',
    );
    const lint = Bun.spawn(
      oxlintCommand(["--no-ignore", outside, inside, allowed]),
      {
        cwd: LINT_ROOT,
        stdout: "pipe",
        stderr: "inherit",
      },
    );
    const report = parseOxlintReport(await new Response(lint.stdout).text());
    expect(await lint.exited).toBe(1);
    expect(report.number_of_files).toBe(3);
    const findings = report.diagnostics
      .map(lintLocation)
      .filter(({ rule }) => rule === "swarm/effect-imports");
    expect(
      findings
        .filter(({ file }) => file?.endsWith("/outside.ts"))
        .map(({ line }) => line)
        .sort((a, b) => a - b),
    ).toEqual([
      1, 2, 3, 4, 5, 6, 7, 9, 12, 13, 14, 15, 16, 17, 21, 22, 23, 24, 25, 26,
      27,
    ]);
    expect(
      findings
        .filter(({ file }) => file?.endsWith("/inside.ts"))
        .map(({ message }) => message)
        .sort(),
    ).toEqual([
      ...Array(3).fill(
        "Import an Effect module subpath. The effect barrel is forbidden.",
      ),
      ...Array(2).fill(
        "Use a named import from Effect so the stability of its exports can be checked.",
      ),
    ]);
    expect(findings.some(({ file }) => file?.endsWith("/allowed.ts"))).toBe(
      false,
    );
  } finally {
    rmSync(plain, { recursive: true, force: true });
    rmSync(zone, { recursive: true, force: true });
  }
});
