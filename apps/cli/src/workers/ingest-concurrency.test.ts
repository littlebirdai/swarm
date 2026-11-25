import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadScaledMs } from "../test-helpers/machineLoad.js";
import {
  closeDaemonWorkers,
  configureDaemonWorkers,
  ingestWorkerHost,
} from "./bridge.js";
import { readTranscriptIngest } from "./ingest-client.js";

test(
  "up to 30 concurrent transcripts drain through four worker cursors in file order",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "worker-cursors-"));
    try {
      await configureDaemonWorkers(
        true,
        {},
        {},
        {
          invocation: {
            command: process.execPath,
            args: [
              path.join(import.meta.dir, "../main.ts"),
              "_worker",
              "ingest",
            ],
          },
        },
      );
      const host = ingestWorkerHost()!;
      const inputs = await Promise.all(
        Array.from({ length: 30 }, async (_, index) => {
          const sessionId = String(index);
          const file = path.join(root, sessionId + ".jsonl");
          const payload = "Synthetic text. ".repeat(10_000);
          const ids = [`${sessionId}-first`, `${sessionId}-second`];
          const text =
            ids
              .map((uuid) =>
                JSON.stringify({
                  type: "assistant",
                  uuid,
                  timestamp: "2026-09-05T00:00:00Z",
                  message: { role: "assistant", content: uuid + payload },
                }),
              )
              .join("\n") + "\n";
          await writeFile(file, text);
          return {
            input: { client: "claude" as const, file, sessionId, offset: 0 },
            ids,
            bytes: Buffer.byteLength(text),
          };
        }),
      );
      const outcomes = await Promise.allSettled(
        inputs.map(({ input }) => readTranscriptIngest(input)),
      );
      const failures = outcomes.flatMap((row) =>
        row.status === "rejected" ? [String(row.reason)] : [],
      );
      expect(failures).toEqual([]);
      for (const [index, outcome] of outcomes.entries()) {
        if (outcome.status !== "fulfilled") throw outcome.reason;
        const { ids, bytes } = inputs[index];
        expect(outcome.value.messages.map((message) => message.uuid)).toEqual(
          ids,
        );
        expect(outcome.value.bytesConsumed).toBe(bytes);
      }
      expect(host.state.pid).toBeGreaterThan(1);
      expect(host.state.pending).toBe(0);
    } finally {
      closeDaemonWorkers();
      await rm(root, { recursive: true, force: true });
    }
  },
  loadScaledMs(60_000),
);
