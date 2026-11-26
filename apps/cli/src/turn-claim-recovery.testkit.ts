import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";

export async function bootFixture(dir: string, source: string) {
  const script = path.join(dir, "daemon.ts");
  fs.writeFileSync(script, source);
  const child = Bun.spawn(
    [
      process.execPath,
      script,
      path.join(dir, "claims.json"),
      path.join(dir, "resumes.jsonl"),
    ],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
      timeout: 10_000,
      killSignal: "SIGKILL",
    },
  );
  const output = createInterface({ input: Readable.from(child.stdout) });
  const lines = output[Symbol.asyncIterator]();
  const waitFor = async (want: string) => {
    for (;;) {
      const line = await lines.next();
      if (line.done)
        throw new Error(
          `Turn fixture exited with ${await child.exited} before ${want}`,
        );
      if (line.value === want) return;
    }
  };
  const finish = async (signal: "SIGTERM" | "SIGKILL") => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill(signal);
    await child.exited;
    output.close();
  };
  try {
    await waitFor("booted");
  } catch (error) {
    await finish("SIGKILL");
    throw error;
  }
  return {
    status: async (status: string, boundary = false) => {
      child.stdin.write(
        JSON.stringify({
          session: "sess-1",
          conv: "conv-1",
          status,
          boundary,
        }) + "\n",
      );
      await child.stdin.flush();
      await waitFor(`ack ${status}`);
    },
    kill: () => finish("SIGKILL"),
    stop: async () => {
      child.stdin.end();
      await finish("SIGTERM");
    },
  };
}
