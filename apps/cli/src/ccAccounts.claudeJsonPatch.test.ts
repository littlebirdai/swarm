// `patchOauthAccount` is a read-modify-write over a file codecast does not own.
// ~/.claude.json is CC's own config — per-project history, MCP servers, settings,
// megabytes of it on an established machine — and codecast owns exactly one key
// in it. Every case below asks the same question: when the read half fails, does
// the write half still fire and take the rest of the file with it?
//
// The interesting failure is not exotic. CC rewrites this file non-atomically
// from every running claude process, so reading it mid-write returns truncated
// JSON, and an account switch runs at exactly the moments claude is busy.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { patchOauthAccount, readOauthAccount } from "./ccAccounts.js";

const ACCOUNT = { emailAddress: "new@example.com", accountUuid: "uuid-new" };

// What CC keeps in the file besides our one key. Nothing here is reconstructible
// from anywhere else on the machine, which is the whole reason to refuse a write.
const EXISTING_CONFIG = {
  oauthAccount: { emailAddress: "old@example.com", accountUuid: "uuid-old" },
  numStartups: 412,
  projects: { "/Users/x/src/thing": { history: ["a query", "another query"] } },
  mcpServers: { linear: { command: "linear-mcp" } },
};

describe("patchOauthAccount: never trade CC's config for one key", () => {
  let home: string;
  let savedHome: string | undefined;
  const configPath = () => path.join(home, ".claude.json");

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "cc-claudejson-"));
    savedHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("replaces our key and leaves every other one untouched", () => {
    fs.writeFileSync(configPath(), JSON.stringify(EXISTING_CONFIG, null, 2));

    patchOauthAccount(ACCOUNT);

    const after = JSON.parse(fs.readFileSync(configPath(), "utf-8"));
    expect(after.oauthAccount).toEqual(ACCOUNT);
    expect(after.numStartups).toBe(412);
    expect(after.projects).toEqual(EXISTING_CONFIG.projects);
    expect(after.mcpServers).toEqual(EXISTING_CONFIG.mcpServers);
  });

  it("creates the file when there is none, which is first run and not a failure", () => {
    patchOauthAccount(ACCOUNT);

    expect(JSON.parse(fs.readFileSync(configPath(), "utf-8"))).toEqual({
      oauthAccount: ACCOUNT,
    });
    expect(readOauthAccount()).toEqual(ACCOUNT);
  });

  it("writes over a zero-byte config, which has nothing left to lose", () => {
    fs.writeFileSync(configPath(), "");

    patchOauthAccount(ACCOUNT);

    expect(readOauthAccount()).toEqual(ACCOUNT);
  });

  it("keeps the permissions the config already has", () => {
    fs.writeFileSync(configPath(), JSON.stringify(EXISTING_CONFIG));
    fs.chmodSync(configPath(), 0o600);

    patchOauthAccount(ACCOUNT);

    // A user who hardened a file holding their OAuth identity must not find it
    // world-readable again after an account switch.
    expect((fs.statSync(configPath()).mode & 0o777).toString(8)).toBe("600");
  });

  it.each([
    {
      name: "torn write",
      bytes: JSON.stringify(EXISTING_CONFIG, null, 2).slice(0, 120),
      reason: "not valid JSON",
    },
    { name: "array", bytes: "[1, 2]", reason: "an array" },
    { name: "null", bytes: "null", reason: "parsed as null" },
    { name: "unreadable", bytes: "{}", reason: "Cannot read" },
  ])(
    "refuses $name and preserves the original bytes",
    ({ name, bytes, reason }) => {
      const unreadable = name === "unreadable";
      if (unreadable && process.getuid?.() === 0) return;
      const file = configPath();
      fs.writeFileSync(file, bytes);
      if (unreadable) fs.chmodSync(file, 0o000);

      let message = "";
      try {
        patchOauthAccount(ACCOUNT);
      } catch (error) {
        message = (error as Error).message;
      } finally {
        if (unreadable) fs.chmodSync(file, 0o600);
      }
      expect(message).toContain(reason);
      expect(message).toContain(".claude.json");
      expect(message).toMatch(/refusing to rewrite/);
      expect(message).toMatch(/re-run the switch|repair or move/i);
      expect(fs.readFileSync(file, "utf8")).toBe(bytes);
    },
  );
});
