import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "../proc.js";
import { sampleDaemonMemory } from "./memorySampler.js";

test.skipIf(process.platform === "win32")(
  "samples RSS for live PIDs from the daemon inventory and identifies their agent binary",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "bench-rss-"));
    const entry = join(dir, "codex");
    await writeFile(entry, 'console.log("ready"); setInterval(() => {}, 1000);');
    const exited = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await new Promise(resolve => exited.once("close", resolve));
    const child = spawn(process.execPath, [entry], { stdio: ["ignore", "pipe", "ignore"] });
    const closed = new Promise(resolve => child.once("close", resolve));
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ pid: process.pid, rssBytes: 1, agentPids: [child.pid, exited.pid] }),
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout?.once("data", () => resolve());
        child.once("error", reject);
        child.once("exit", code => reject(new Error(`fixture exited with ${code}`)));
      });
      const headers = { Authorization: "Bearer fixture" };
      const sample = await sampleDaemonMemory(process.pid, server.port!, headers);
      expect(sample.daemonRssBytes).toBeGreaterThan(1024);
      expect(sample.agents).toEqual([{ identity: expect.stringMatching(new RegExp(`^${child.pid}:`)), provider: "codex", rssBytes: expect.any(Number) }]);
      expect(sample.agents?.[0].rssBytes).toBeGreaterThan(0);
      expect((await sampleDaemonMemory(process.pid, server.port!, null)).agents).toBeNull();
    } finally {
      child.kill();
      await closed;
      await server.stop(true);
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "keeps agent RSS when ps prints more than a megabyte of argv",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "bench-rss-big-"));
    const entry = join(dir, "codex");
    await writeFile(entry, 'console.log("ready"); setInterval(() => {}, 1000);');
    // Linux caps one argument at 128 KiB (MAX_ARG_STRLEN), so the 400 KiB of argv
    // each child carries is split across four arguments.
    const prompt = Array.from({ length: 4 }, () => "x".repeat(100 * 1024));
    const children = [0, 1, 2].map(() => spawn(process.execPath, [entry, ...prompt], { stdio: ["ignore", "pipe", "ignore"] }));
    const closed = children.map(child => new Promise(resolve => child.once("close", resolve)));
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ pid: process.pid, rssBytes: 1, agentPids: children.map(child => child.pid) }),
    });
    try {
      await Promise.all(children.map(child => new Promise<void>((resolve, reject) => {
        child.stdout?.once("data", () => resolve());
        child.once("exit", code => reject(new Error(`fixture exited with ${code}`)));
      })));
      const sample = await sampleDaemonMemory(process.pid, server.port!, { Authorization: "Bearer fixture" });
      expect(sample.agents?.length).toBe(3);
    } finally {
      for (const child of children) child.kill();
      await Promise.all(closed);
      await server.stop(true);
      await rm(dir, { recursive: true, force: true });
    }
  },
);
