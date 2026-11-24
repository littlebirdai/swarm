import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hookPortFile } from "./loopbackIdentity.js";
import { personEnv } from "./sessionIdentity.js";

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
      writeFileSync(path.join(home, "daemon.log"), "");
      writeFileSync(hookPortFile(home), String(server.port));
      const child = Bun.spawn(
        [
          process.execPath,
          path.join(import.meta.dir, "main.ts"),
          "bench",
          "daemon",
          "--json",
          "--duration",
          "0.15",
        ],
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

test("CLI test script roots the same source tree and preserves Node build splitting", () => {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  expect(pkg.scripts.test).toBe("bun test ./src/");
  expect(pkg.scripts.build.split(/\s+/)).toContain("--splitting");
});
