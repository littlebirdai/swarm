import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { personEnv } from "./sessionIdentity.js";

const processEntry = path.join(import.meta.dir, "main.ts");
const scratch: string[] = [];

function scratchHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cast-config-cli-"));
  scratch.push(home);
  fs.mkdirSync(path.join(home, ".codecast"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".codecast", "update-state.json"),
    JSON.stringify({ lastCheck: new Date().toISOString() }),
  );
  return home;
}

function runCli(
  home: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [processEntry, ...args], {
      env: {
        ...personEnv(process.env),
        HOME: home,
        CODECAST_DIR: path.join(home, ".codecast"),
        CODECAST_NO_AUTOSTART: "1",
        NO_COLOR: "1",
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end();
  });
}

function config(home: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(home, ".codecast", "config.json"), "utf-8"),
  );
}

afterEach(() => {
  for (const h of scratch.splice(0))
    fs.rmSync(h, { recursive: true, force: true });
});

const agentEnv = { CLAUDE_CODE_SESSION_ID: "auto-bind-test-session" };

function bindingFixture(authToken?: string, bindError?: string) {
  const home = scratchHome();
  const requests: { method: string; path: string; body: unknown }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const requestPath = new URL(request.url).pathname;
      requests.push({
        method: request.method,
        path: requestPath,
        body: await request.json().catch(() => null),
      });
      if (requestPath === "/cli/work/update" && bindError)
        return Response.json({ error: bindError }, { status: 401 });
      return Response.json({});
    },
  });
  fs.writeFileSync(
    path.join(home, ".codecast", "config.json"),
    JSON.stringify({ convex_url: server.url.origin, auth_token: authToken }),
  );
  return { home, requests, server };
}

describe("agent startup binding", () => {
  test.each([{ CODECAST_TASK_ID: "ct-1" }, { CODECAST_PLAN_ID: "pl-1" }])(
    "an unauthenticated agent with %j can change local config",
    async (binding) => {
      const f = bindingFixture();
      try {
        const result = await runCli(
          f.home,
          ["config", "cloud_mirror_enabled", "false"],
          { ...agentEnv, ...binding },
        );
        expect(result.code).toBe(0);
        expect(result.stderr).toBe("");
        expect(config(f.home).cloud_mirror_enabled).toBe(false);
        expect(f.requests).toEqual([]);
        expect(
          fs
            .readdirSync(path.join(f.home, ".codecast"))
            .filter((name) => name.startsWith("plan-log-none-")),
        ).toEqual([]);
      } finally {
        f.server.stop(true);
      }
    },
  );

  test("an authenticated agent still binds its task and plan", async () => {
    const authToken = "local-binding-fixture";
    const f = bindingFixture(authToken);
    try {
      const result = await runCli(
        f.home,
        ["config", "cloud_mirror_enabled", "false"],
        { ...agentEnv, CODECAST_TASK_ID: "ct-1", CODECAST_PLAN_ID: "pl-1" },
      );
      expect(result.code).toBe(0);
      expect(
        f.requests.filter(
          ({ path }) =>
            path === "/cli/work/update" || path === "/cli/plans/bind",
        ),
      ).toEqual([
        {
          method: "POST",
          path: "/cli/work/update",
          body: {
            api_token: authToken,
            short_id: "ct-1",
            status: "in_progress",
            conversation_id: agentEnv.CLAUDE_CODE_SESSION_ID,
          },
        },
        {
          method: "POST",
          path: "/cli/plans/bind",
          body: {
            api_token: authToken,
            short_id: "pl-1",
            conversation_id: agentEnv.CLAUDE_CODE_SESSION_ID,
          },
        },
      ]);
      expect(f.requests).toContainEqual({
        method: "POST",
        path: "/cli/plans/log/unread",
        body: {
          api_token: authToken,
          session_id: agentEnv.CLAUDE_CODE_SESSION_ID,
        },
      });
    } finally {
      f.server.stop(true);
    }
  });

  test("a stored token rejected by the bind still reports the server error", async () => {
    const authToken = "local-rejected-binding-fixture";
    const bindError = "The stored token was revoked";
    const f = bindingFixture(authToken, bindError);
    try {
      const result = await runCli(
        f.home,
        ["config", "cloud_mirror_enabled", "false"],
        { ...agentEnv, CODECAST_TASK_ID: "ct-1" },
      );
      expect(result.code).toBe(1);
      expect(result.stderr.trim()).toBe(`Error: ${bindError}`);
      expect(
        f.requests.filter(({ path }) => path === "/cli/work/update"),
      ).toEqual([
        {
          method: "POST",
          path: "/cli/work/update",
          body: {
            api_token: authToken,
            short_id: "ct-1",
            status: "in_progress",
            conversation_id: agentEnv.CLAUDE_CODE_SESSION_ID,
          },
        },
      ]);
    } finally {
      f.server.stop(true);
    }
  });

  test("an unauthenticated agent still gets the auth error from task ls", async () => {
    const f = bindingFixture();
    try {
      const result = await runCli(f.home, ["task", "ls"], {
        ...agentEnv,
        CODECAST_TASK_ID: "ct-1",
      });
      expect(result.code).toBe(1);
      expect(result.stderr.trim()).toBe("Not authenticated. Run: cast auth");
      expect(f.requests).toEqual([]);
    } finally {
      f.server.stop(true);
    }
  });
});

describe("cast config — the home mirror keys", () => {
  test("an unauthenticated agent can run local config commands", async () => {
    const home = scratchHome();
    const result = await runCli(
      home,
      ["config", "cloud_mirror_enabled", "true"],
      {
        CLAUDE_CODE_SESSION_ID: "fixture-agent",
      },
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(config(home).cloud_mirror_enabled).toBe(true);
    expect(fs.readdirSync(path.join(home, ".codecast"))).not.toContain(
      "plan-log-none-fixture-agent",
    );
  });

  test("cloud_mirror_enabled persists a boolean; true/1/false/0 coerce; anything else is refused", async () => {
    const home = scratchHome();
    expect(
      (await runCli(home, ["config", "cloud_mirror_enabled", "false"])).code,
    ).toBe(0);
    expect(config(home).cloud_mirror_enabled).toBe(false);
    expect(
      (await runCli(home, ["config", "cloud_mirror_enabled", "1"])).code,
    ).toBe(0);
    expect(config(home).cloud_mirror_enabled).toBe(true);
    expect(
      (await runCli(home, ["config", "cloud_mirror_enabled", "0"])).code,
    ).toBe(0);
    expect(config(home).cloud_mirror_enabled).toBe(false);
    expect(
      (await runCli(home, ["config", "cloud_mirror_enabled", "true"])).code,
    ).toBe(0);
    expect(config(home).cloud_mirror_enabled).toBe(true);
    const bad = await runCli(home, ["config", "cloud_mirror_enabled", "maybe"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("takes true or false");
    expect(config(home).cloud_mirror_enabled).toBe(true);
    const shown = await runCli(home, ["config", "cloud_mirror_enabled"]);
    expect(shown.stdout.trim()).toBe("cloud_mirror_enabled: true");
  }, 60_000);

  test("cloud_mirror_exclude and cloud_mirror_include round-trip; an unknown key still exits 1; the listing names the keys", async () => {
    const home = scratchHome();
    expect(
      (
        await runCli(home, [
          "config",
          "cloud_mirror_exclude",
          ".claude/skills/private-*",
        ])
      ).code,
    ).toBe(0);
    expect(config(home).cloud_mirror_exclude).toBe(".claude/skills/private-*");
    expect(
      (await runCli(home, ["config", "cloud_mirror_exclude"])).stdout.trim(),
    ).toBe("cloud_mirror_exclude: .claude/skills/private-*");
    expect(
      (
        await runCli(home, [
          "config",
          "cloud_mirror_include",
          ".dotfiles/skills",
        ])
      ).code,
    ).toBe(0);
    expect(config(home).cloud_mirror_include).toBe(".dotfiles/skills");
    const bogus = await runCli(home, ["config", "bogus", "x"]);
    expect(bogus.code).toBe(1);
    expect(bogus.stderr).toContain("Unknown config key");
    const listing = await runCli(home, ["config"]);
    expect(listing.stdout).toContain("cloud_mirror_enabled: true");
    expect(listing.stdout).toContain(
      "cloud_mirror_exclude: .claude/skills/private-*",
    );
    expect(listing.stdout).toContain("cloud_mirror_include: .dotfiles/skills");
  }, 60_000);
});
