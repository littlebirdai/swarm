import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseLineProfileText } from "../apps/cli/src/lineProfile";
import { evalSignals, signalArgv } from "../apps/evals/src/signals";
import {
  LESSON_SIGNAL,
  lessonFingerprint,
} from "../apps/server/convex/lineLearn";

const root = path.join(import.meta.dir, "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const profile = parseLineProfileText(
  read(".codecast/line.toml"),
  ".codecast/line.toml",
).values;

type Filed = { source: string; kind: string; fingerprint: string };

const producers: Record<string, () => Filed[]> = {
  "eval-drift": () => {
    const out = evalSignals({
      surface: "title",
      regression: true,
      gatesFailed: ["lengths"],
      failingFreezes: ["e22b47f0aa"],
      summary: [],
    });
    return out.map((s) => {
      const argv = signalArgv(s);
      return {
        source: argv[argv.indexOf("--source") + 1],
        kind: argv[argv.indexOf("--kind") + 1],
        fingerprint: argv[argv.indexOf("--fingerprint") + 1],
      };
    });
  },
  lessons: () => {
    const skill = read("apps/cli/skills/cast-lessons/SKILL.md");
    const source = skill.match(/--source (\S+)/)?.[1] ?? "";
    const kind = skill.match(/--kind (\S+)/)?.[1] ?? "";
    expect(skill).toMatch(/--fingerprint lesson:<rule-slug>/);
    expect(skill).toMatch(/--project /);
    return [
      {
        ...LESSON_SIGNAL,
        fingerprint: lessonFingerprint("ct-7", "add a test"),
      },
      { source, kind, fingerprint: "lesson:PR-code-4" },
    ];
  },
};

function fingerprintPattern(declared: string): RegExp {
  const alternatives: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of declared.replace(/\([^)]*\)/g, "")) {
    if (ch === "<") depth++;
    if (ch === ">") depth--;
    if (ch === "," && depth === 0) {
      alternatives.push(current.trim());
      current = "";
    } else current += ch;
  }
  alternatives.push(current.trim());
  const one = (alt: string) =>
    alt
      .split(/<[^>]*>/)
      .map((lit) => lit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("\\S+");
  return new RegExp(`^(?:${alternatives.filter(Boolean).map(one).join("|")})$`);
}

describe("codecast's declared finders", () => {
  const finders = profile.finders ?? [];

  test("the producers in code are declared", () => {
    expect(finders.map((finder) => finder.id)).toEqual(
      expect.arrayContaining(Object.keys(producers)),
    );
  });

  for (const finder of finders.filter(({ id }) => producers[id])) {
    test(`${finder.id} files what it declares`, () => {
      const filed = producers[finder.id]();
      expect(filed.length).toBeGreaterThan(0);
      const pattern = fingerprintPattern(finder.fingerprint);
      for (const s of filed) {
        expect(s.source).toBe(finder.source);
        if (finder.kind !== "any") expect(finder.kind).toContain(s.kind);
        expect(s.fingerprint).toMatch(pattern);
      }
    });
  }

  test("the declared shape is read the way it is written", () => {
    const p = fingerprintPattern(
      "evals:<surface>:<gate, freeze or separated-worse>",
    );
    expect("evals:title:lengths").toMatch(p);
    expect("evals:title").not.toMatch(p);
    const lessons = fingerprintPattern(
      "lesson:<task>:<note hash> (a card's note), lesson:<rule slug> (cast-lessons)",
    );
    expect("lesson:ct-7:0a1b2c3d").toMatch(lessons);
    expect("lesson:PR-code-4").toMatch(lessons);
    expect("insight:jx7:abc").not.toMatch(lessons);
  });
});
