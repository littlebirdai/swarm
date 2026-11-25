// An isolated session whose worktree could not be made used to start in the
// repo root, so a line hand on a full disk would have edited and committed in
// the main checkout (2026-10-24). The start now fails with why, and a full
// disk latches the machine's line hold (diskFull.ts). This reads the source:
// the start path needs a booted daemon.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { functionBlock } from "./test-helpers/sourceRegion.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const daemon = fs.readFileSync(path.join(here, "daemon.ts"), "utf8");
const legacy = fs.readFileSync(path.join(here, "worktreeLegacy.ts"), "utf8");

describe("an isolated start never falls back to the main checkout", () => {
  test("a worktree that cannot be made fails the start, latching a full disk", () => {
    const startSession = fs.readFileSync(
      new URL("./daemon-commands/start-session.ts", import.meta.url),
      "utf8",
    );
    const at = startSession.indexOf(
      "const made = await createWorktree(gitRoot, wtName);",
    );
    expect(at).toBeGreaterThan(0);
    const failure = startSession.slice(
      at,
      startSession.indexOf("worktreeResult = made;", at),
    );
    expect(failure).toContain(`if ("error" in made)`);
    expect(failure).toMatch(/diskFullFailReason\(\s*gitRoot,/);
    expect(failure).toContain(
      "setSessionError(conversationId, commandOutcome.error)",
    );
    expect(failure).toMatch(/\n\s*break;\n/);
    const launchSession = fs.readFileSync(
      new URL("./daemon-commands/launch-session.ts", import.meta.url),
      "utf8",
    );
    expect(daemon + startSession + launchSession).not.toContain(
      "falling back to repo root",
    );
  });

  test("createWorktree reports why it failed instead of null", () => {
    expect(functionBlock(daemon, "createWorktree").text).toContain(
      "Promise<WorktreeResult | { error: string }>",
    );
    expect(functionBlock(legacy, "createWorktreeLegacy").text).not.toMatch(
      /return null;/,
    );
  });
});
