import { describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { resolveCapabilities } from "../src/capabilityResolver";

// Regenerate DELIBERATELY after an intended rule change and show the fixture
// diff in the same commit — a fixture updated alone is indistinguishable from
// a regression goldened away.

const DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
  "resolver",
);

export function goldenCases(): Array<{
  name: string;
  input: any;
  output: any;
}> {
  return fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({
      name: f.replace(/\.json$/, ""),
      ...JSON.parse(fs.readFileSync(path.join(DIR, f), "utf-8")),
    }));
}

describe("resolver golden parity (shared)", () => {
  const cases = goldenCases();

  it("finds every fixture", () => {
    expect(cases.length).toBeGreaterThanOrEqual(15);
  });

  it("covers every ignore reason the contract exports", () => {
    const reasons = new Set(
      cases.flatMap((c) => (c.output.ignored ?? []).map((i: any) => i.reason)),
    );
    for (const reason of [
      "scope_not_in_context",
      "client_filtered",
      "client_cannot_express",
      "loadout_not_expanded",
      "unpinned_source",
      "client_too_old",
      "malformed_binding",
    ]) {
      expect(reasons.has(reason), `no fixture produces ${reason}`).toBe(true);
    }
  });

  for (const c of goldenCases()) {
    it(`byte-identical on ${c.name}`, () => {
      const actual = resolveCapabilities(c.input.bindings, c.input.context);
      expect(JSON.stringify(actual)).toBe(JSON.stringify(c.output));
    });
  }
});
