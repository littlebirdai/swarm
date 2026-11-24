import { expect, test } from "bun:test";
import { AccountLifecycleGate } from "./accountLifecycleGate";

async function resume<T>(
  gate: AccountLifecycleGate,
  agentType: string | undefined,
  launch: () => Promise<T>,
): Promise<T> {
  const release = await gate.acquireResume(agentType);
  try {
    return await launch();
  } finally {
    release();
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("queued account switches settle before a waiting resume reads the login", async () => {
  const gate = new AccountLifecycleGate();
  const first = await gate.acquireSwitch();
  let account = "first";
  const second = gate.acquireSwitch().then((release) => {
    account = "second";
    release();
  });
  const launch = resume(gate, "claude", async () => account);
  const codex = resume(gate, "codex", async () => "codex ready");
  expect(await codex).toBe("codex ready");
  first();
  await second;
  expect(await launch).toBe("second");
});

test("independent Claude resumes remain concurrent and a failed boot releases its hold", async () => {
  const gate = new AccountLifecycleGate();
  const ready = deferred();
  const first = resume(gate, "claude", async () => {
    await ready.promise;
    return "first";
  });
  expect(await resume(gate, "claude", async () => "second")).toBe("second");
  await expect(
    resume(gate, undefined, async () => {
      throw new Error("boot failed");
    }),
  ).rejects.toThrow("boot failed");
  ready.resolve();
  expect(await first).toBe("first");
  const release = await gate.acquireSwitch();
  release();
  release();
  expect(await resume(gate, "claude", async () => "recovered")).toBe(
    "recovered",
  );
});
