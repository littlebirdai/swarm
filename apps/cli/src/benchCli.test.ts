import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hookPortFile } from "./loopbackIdentity.js";
import { personEnv } from "./sessionIdentity.js";

const cli = [process.execPath, path.join(import.meta.dir, "main.ts")];

test.each([
  { health: 200, exit: 0, status: "NOT ESTABLISHED" },
  { health: 503, exit: 1, status: "FAIL" },
])(
  "bench daemon returns $exit for a health status of $health",
  async ({ health, exit, status }) => {
    const home = mkdtempSync(path.join(tmpdir(), "cast-bench-cli-"));
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const route = new URL(request.url).pathname;
        return new Response(null, {
          status: route === "/health" ? health : 400,
        });
      },
    });
    try {
      writeFileSync(
        path.join(home, "config.json"),
        JSON.stringify({
          auth_token: "fixture-token",
          convex_url: server.url.origin,
          user_id: "fixture-user",
        }),
      );
      writeFileSync(path.join(home, "daemon.pid"), String(process.pid));
      const now = Date.now();
      const hourMs = 3_600_000;
      writeFileSync(
        path.join(home, "daemon.log"),
        [25, 23]
          .map(
            (hours) =>
              `[${new Date(now - hours * hourMs).toISOString()}] Daemon log entry`,
          )
          .join("\n"),
      );
      writeFileSync(hookPortFile(home), String(server.port));
      const child = Bun.spawn(
        [...cli, "bench", "daemon", "--json", "--duration", "0.15"],
        {
          env: {
            ...personEnv(process.env),
            HOME: home,
            CODECAST_DIR: home,
            CODECAST_NO_AUTO_UPDATE: "1",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code, stderr).toBe(exit);
      const report = JSON.parse(stdout);
      expect(report.acceptance.status).toBe(status);
      expect(report.load).toBeNull();
      expect(report.log.linesRead).toBe(1);
      expect(report.log.sinceMs).toBeGreaterThanOrEqual(now - 24 * hourMs);
      expect(report.log.sinceMs).toBeLessThanOrEqual(Date.now() - 24 * hourMs);
      expect(report.observe.loopLag.durationMs).toBe(150);
      expect(report.observe.loopLag.statuses[String(health)]).toBeGreaterThan(
        0,
      );
    } finally {
      server.stop(true);
      rmSync(home, { recursive: true, force: true });
    }
  },
  30_000,
);

test("bench daemon help lists the default duration, sample size, and churn interval", () => {
  const help = Bun.spawnSync([...cli, "bench", "daemon", "--help"]);
  expect(help.exitCode, help.stderr.toString()).toBe(0);
  const output = help.stdout.toString().replace(/\n {4,}/g, " ");
  expect(output).toMatch(/--duration <seconds>[^\n]*\(default: "60"\)/);
  expect(output).toMatch(/--sample <k>[^\n]*\(default: "5"\)/);
  expect(output).toMatch(/--churn-interval <ms>[^\n]*\(default: "2000"\)/);
});

test("CLI package scripts scope tests, stamp the daemon build, guard the binary build, and preserve Node build splitting", () => {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  expect(pkg.scripts.test).toBe("bun test ./src/");
  expect(pkg.scripts.build.split(/\s+/)).toContain("--splitting");
  expect(pkg.scripts.build.split(" && ")).toContain(
    "bun scripts/stamp-daemon-build-id.ts",
  );
  expect(pkg.scripts["build:binary"].split(" && ")).toContain(
    "bash scripts/guard-no-src-shadow.sh",
  );
});
