import { expect } from "bun:test";
import { join } from "node:path";
import type { acquireWorkspace } from "./lifecycle.js";
import { randomInt } from "node:crypto";
import { isPortFree } from "./ports.js";

export async function freeWorkspacePortBase(): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const base = randomInt(20_000, 28_000);
    const free = await Promise.all(
      Array.from({ length: 12 }, (_, index) => {
        const web = base + index * 100;
        return Promise.all([isPortFree(web), isPortFree(web + 1)]);
      }),
    );
    if (free.flat().every(Boolean)) return base;
  }
  throw new Error("Could not find a free workspace port range");
}

export function workspaceOperationGate() {
  const arrived = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      arrived.resolve();
      await released.promise;
      return new Response("released");
    },
  });
  return {
    url: server.url.href,
    arrived: arrived.promise,
    release: released.resolve,
    stop: () => server.stop(true),
  };
}

export async function acquireWorkspaceInProcess(
  root: string,
  name: string,
  opts: Parameters<typeof acquireWorkspace>[2],
) {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
    import { acquireWorkspace } from ${JSON.stringify(join(import.meta.dir, "lifecycle.ts"))};
    const result = await acquireWorkspace(${JSON.stringify(root)}, ${JSON.stringify(name)}, ${JSON.stringify(opts)});
    console.log(JSON.stringify(result));
  `,
    ],
    { stdout: "pipe", stderr: "pipe", env: process.env },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  expect(stdout.length).toBeGreaterThan(0);
  return JSON.parse(stdout) as Awaited<ReturnType<typeof acquireWorkspace>>;
}
