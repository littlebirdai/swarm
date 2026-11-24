import { expect, test } from "bun:test";

test("transcript resizing preserves geometry and progress without redundant renders", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "test",
      "--timeout=60000",
      `${import.meta.dir}/fixtures/conversationVirtualizer.tsx`,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 240_000,
      killSignal: "SIGKILL",
    },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ code, stdout, stderr }).toMatchObject({ code: 0 });
  expect(stderr).toMatch(/\b[1-9]\d* pass\b/);
  expect(stderr).toMatch(/\b0 fail\b/);
  expect(stderr).not.toMatch(/\b[1-9]\d* skip\b/);
}, 250_000);

test("the legacy anchored list suspends and resumes its landing timer", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "test",
      "--test-name-pattern",
      "the anchored list suspends",
      `${import.meta.dir}/fixtures/conversationVirtualizer.tsx`,
    ],
    {
      env: { ...process.env, TEST_LEGACY_LIST: "1" },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
      killSignal: "SIGKILL",
    },
  );
  const [code, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  expect({ code, stderr }).toMatchObject({ code: 0 });
  expect(stderr).toContain("1 pass");
}, 65_000);
