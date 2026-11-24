import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotProcessTable } from "../processTable";
import { shellQuote } from "../shellQuote";
import { pollUntil } from "../test-helpers/pollUntil";
import { pidGone } from "../test-helpers/processLiveness";
import { stopSteps, trackStep } from "./mergeScratch";

describe("stopSteps", () => {
  async function withStep(
    command: string,
    check: (step: ReturnType<typeof spawn>, dir: string) => Promise<void>,
  ) {
    const dir = mkdtempSync(join(tmpdir(), "merge-step-"));
    const step = spawn("/bin/bash", ["-c", command], {
      cwd: dir,
      detached: true,
    });
    const closed = once(step, "close");
    trackStep(step);
    try {
      await check(step, dir);
    } finally {
      const ready = join(dir, "ready");
      if (existsSync(ready)) {
        const pid = Number(readFileSync(ready, "utf-8"));
        if (pid > 1) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        }
      }
      step.kill("SIGKILL");
      await closed;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const waitForFile = (dir: string, file: string) =>
    pollUntil(() => existsSync(join(dir, file)), `the step writing ${file}`);
  const childPid = (dir: string) =>
    Number(readFileSync(join(dir, "ready"), "utf-8"));
  const mark = `open(my $f, ">", "starting") or die $!; print $f $$; close($f); rename("starting", "ready") or die $!;`;
  const background = (script: string) => `perl -e ${shellQuote(script)} &`;
  const heldPipeChild = (term: string) =>
    background(
      `${term} ${mark} while (!-f "close-pipes") { select undef, undef, undef, 0.01 } close STDOUT; close STDERR; sleep 30;`,
    );
  const waitForShell = "while [ ! -f leave ]; do sleep 0.02; done";
  const ageChild = (pid: number) =>
    pollUntil(
      () => {
        const row = snapshotProcessTable({ timeout: 500 }).find(
          (r) => r.pid === pid,
        );
        return (
          !!row?.startedAt &&
          Date.parse(row.startedAt) < Math.floor(Date.now() / 1000) * 1000
        );
      },
      "the child start time preceding the current second",
      { every: 50 },
    );

  async function withStepReads(read: string, run: string) {
    const dir = mkdtempSync(join(tmpdir(), "merge-reads-"));
    const driver = join(dir, "driver.ts");
    writeFileSync(
      join(dir, "ps"),
      `#!${process.execPath}
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pollUntil } from ${JSON.stringify(join(import.meta.dir, "../test-helpers/pollUntil.ts"))};
const waitFor = (path) => pollUntil(() => existsSync(path), path);
const ps = () => Bun.spawnSync([ ${JSON.stringify(Bun.which("ps")!)}, ...process.argv.slice(2) ]);
if (process.argv[2] !== "-axww") process.exit(1);
${read}
`,
      { mode: 0o755 },
    );
    writeFileSync(
      driver,
      `
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { stopSteps, trackStep } from ${JSON.stringify(join(import.meta.dir, "mergeScratch.ts"))};
import { pollUntil } from ${JSON.stringify(join(import.meta.dir, "../test-helpers/pollUntil.ts"))};
const dir = process.cwd();
const waitFor = (path) => pollUntil(() => existsSync(path), path);
function step(command) {
  const child = spawn("/bin/bash", ["-c", command], { cwd: dir, detached: true });
  const exited = once(child, "exit").then(() => writeFileSync("exited", ""));
  const closed = once(child, "close");
  writeFileSync("group", String(child.pid));
  trackStep(child);
  return { child, exited, closed };
}
${run}
`,
    );
    const proc = Bun.spawn([process.execPath, driver], {
      cwd: dir,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      await pollUntil(
        () => proc.exitCode !== null,
        "the process read fixture exiting",
      );
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      if (proc.exitCode !== 0) throw new Error(stderr);
      return stdout.trim();
    } finally {
      proc.kill("SIGKILL");
      await proc.exited;
      for (const file of ["ready", "group"]) {
        if (!existsSync(join(dir, file))) continue;
        const pid = Number(readFileSync(join(dir, file), "utf-8"));
        if (pid > 1) {
          try {
            process.kill(file === "group" ? -pid : pid, "SIGKILL");
          } catch {}
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("keeps a child identified in a read that returns after the shell exits", async () => {
    const command = `trap '' TERM; perl -e ${shellQuote(`$SIG{TERM}="IGNORE"; ${mark} sleep 30;`)} </dev/null >/dev/null 2>&1 & ${waitForShell}`;
    const actual = await withStepReads(
      `
if (!existsSync("sampled")) {
  await waitFor("stop");
  const table = ps();
  writeFileSync("sampled", "");
  writeFileSync("leave", "");
  await waitFor("exited");
  process.stdout.write(table.stdout);
} else process.stdout.write(ps().stdout);
`,
      `
const running = step(${JSON.stringify(command)});
await waitFor("ready");
writeFileSync("stop", "");
const stopped = await stopSteps(800);
await running.closed;
process.kill(Number(readFileSync("ready", "utf8")), 0);
console.log(stopped);
`,
    );
    expect(actual).toBe("false");
  });

  test("sends TERM while a process read still waits for output", async () => {
    const command = `trap 'touch received; exit 0' TERM; touch armed; while :; do sleep 0.02; done`;
    const actual = await withStepReads(
      `
writeFileSync("read", String(process.pid));
await waitFor("allow-read");
process.stdout.write(ps().stdout);
`,
      `
const running = step(${JSON.stringify(command)});
await waitFor("armed");
const stopped = stopSteps(1_000);
await waitFor("read");
await waitFor("received");
const reader = Number(readFileSync("read", "utf8"));
let pending = true;
try { process.kill(reader, 0); } catch { pending = false; }
console.log(pending);
writeFileSync("allow-read", "");
await running.closed;
await stopped;
`,
    );
    expect(actual).toBe("true");
  });

  test.each([
    {
      name: "the first process read fails",
      read: "process.exit(1);",
      expected: false,
    },
    {
      name: "later process reads fail",
      read: 'if (existsSync("exited")) process.exit(1); process.stdout.write(ps().stdout); writeFileSync("sampled", "");',
      expected: false,
    },
    {
      name: "the known child changes start time",
      read: 'if (existsSync("exited")) console.log("700 1 700 0 ? Wed Jan 1 00:00:00 2020 unrelated"); else { console.log("700 1 " + readFileSync("group", "utf8") + " 0 ? Thu Jan 1 00:00:00 1970 target"); process.stdout.write(ps().stdout); writeFileSync("sampled", ""); }',
      expected: true,
    },
    {
      name: "the known child lives in a new group",
      read: 'if (existsSync("exited")) console.log("700 1 799 0 ? Thu Jan 1 00:00:00 1970 target"); else { console.log("700 1 " + readFileSync("group", "utf8") + " 0 ? Thu Jan 1 00:00:00 1970 target"); process.stdout.write(ps().stdout); writeFileSync("sampled", ""); }',
      expected: false,
    },
    {
      name: "the known child is a zombie",
      read: 'if (existsSync("exited")) console.log("700 1 799 0 ? Thu Jan 1 00:00:00 1970 target <defunct>"); else { console.log("700 1 " + readFileSync("group", "utf8") + " 0 ? Thu Jan 1 00:00:00 1970 target"); process.stdout.write(ps().stdout); writeFileSync("sampled", ""); }',
      expected: true,
    },
  ])("requires proof when $name", async ({ read, expected, name }) => {
    const command = `trap 'exit 0' TERM; touch armed; while :; do sleep 0.02; done`;
    const actual = await withStepReads(
      read,
      `
const kill = process.kill;
process.kill = (pid, signal) => pid === 700 ? true : kill(pid, signal);
const running = step(${JSON.stringify(command)});
await waitFor("armed");
${name.includes("first") ? "" : 'await waitFor("sampled");'}
const stopped = await stopSteps(700);
await running.closed;
console.log(stopped);
`,
    );
    expect(actual).toBe(String(expected));
  });

  test("requires the step pipes to close even when the process read is clear", async () => {
    const command = `${heldPipeChild('$SIG{TERM}="IGNORE";')} ${waitForShell}`;
    const actual = await withStepReads(
      `
if (existsSync("exited")) console.log("1 0 1 0 ? Thu Jan 1 00:00:00 1970 init");
else {
  process.stdout.write(ps().stdout);
  writeFileSync("sampled", "");
}
`,
      `
const running = step(${JSON.stringify(command)});
await waitFor("ready");
await waitFor("sampled");
writeFileSync("leave", "");
await running.exited;
const stopped = await stopSteps(500);
process.kill(Number(readFileSync("ready", "utf8")), 0);
console.log(stopped);
writeFileSync("close-pipes", "");
await running.closed;
`,
    );
    expect(actual).toBe("false");
  });

  test("leaves a process with an exited shell's reused group ID alone", async () => {
    const other = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    const closed = once(other, "close");
    try {
      await withStep(
        `${heldPipeChild('$SIG{TERM}="IGNORE";')} ${waitForShell}`,
        async (step, dir) => {
          await waitForFile(dir, "ready");
          await ageChild(childPid(dir));
          const exited = once(step, "exit");
          step.kill("SIGKILL");
          await exited;
          expect(step.signalCode).toBe("SIGKILL");
          const kill = process.kill;
          process.kill = (pid, sig) =>
            kill(pid === -step.pid! ? -other.pid! : pid, sig);
          try {
            const stopped = stopSteps(500);
            writeFileSync(join(dir, "close-pipes"), "");
            expect(await stopped).toBe(false);
            expect(await pidGone(other.pid!)).toBe(false);
          } finally {
            process.kill = kill;
          }
        },
      );
    } finally {
      other.kill("SIGKILL");
      await closed;
    }
  });

  test("keeps the tree when a TERM trap starts a child before the shell exits", async () => {
    const fork = `perl -e ${shellQuote(`$SIG{TERM}="IGNORE"; ${mark} sleep 30;`)} </dev/null >/dev/null 2>&1 & ${waitForShell}; exit 0`;
    await withStep(
      `trap ${shellQuote(fork)} TERM; touch armed; while :; do sleep 0.02; done`,
      async (step, dir) => {
        await waitForFile(dir, "armed");
        const exited = once(step, "exit");
        const stopped = stopSteps(1_500);
        await waitForFile(dir, "ready");
        writeFileSync(join(dir, "leave"), "");
        await exited;
        expect(await stopped).toBe(false);
        expect(await pidGone(childPid(dir))).toBe(false);
      },
    );
  });

  test.each([
    { mode: "ignores TERM", term: '$SIG{TERM}="IGNORE";', expected: false },
    {
      mode: "accepts TERM",
      term: "$SIG{TERM}=sub { exit 0 };",
      expected: true,
    },
  ])(
    "handles a child that $mode after its shell exits",
    async ({ term, expected }) => {
      await withStep(
        `${heldPipeChild(term)} ${waitForShell}`,
        async (step, dir) => {
          await waitForFile(dir, "ready");
          const pid = childPid(dir);
          await ageChild(pid);
          const exited = once(step, "exit");
          writeFileSync(join(dir, "leave"), "");
          await exited;
          const stopped = stopSteps(1_000);
          if (!expected) {
            const closed = once(step, "close");
            writeFileSync(join(dir, "close-pipes"), "");
            await closed;
          }
          expect(await stopped).toBe(expected);
          expect(await pidGone(pid)).toBe(expected);
        },
      );
    },
  );

  test("keeps the tree when a job-control child outlives its shell", async () => {
    const job = `perl -e ${shellQuote(`$SIG{TERM}="IGNORE"; ${mark} sleep 30;`)}`;
    const command = `trap ${shellQuote(`${waitForShell}; exit 0`)} TERM; set -m; ${job} </dev/null >/dev/null 2>&1 & wait`;
    const actual = await withStepReads(
      `
if (!existsSync("sampled")) {
  await waitFor("stop");
  const table = ps();
  writeFileSync("sampled", "");
  process.stdout.write(table.stdout);
} else process.stdout.write(ps().stdout);
`,
      `
const running = step(${JSON.stringify(command)});
await waitFor("ready");
const pid = Number(readFileSync("ready", "utf8"));
const table = Bun.spawnSync([${JSON.stringify(Bun.which("ps")!)}, "-p", String(pid), "-o", "pgid="]);
if (Number(table.stdout.toString()) !== pid) throw new Error("the job has no group of its own");
writeFileSync("stop", "");
const stopped = stopSteps(800);
await waitFor("sampled");
writeFileSync("leave", "");
await running.closed;
process.kill(pid, 0);
console.log(await stopped);
`,
    );
    expect(actual).toBe("false");
  });

  test("keeps a child that creates a new session after TERM", async () => {
    const perl = `use POSIX (); $SIG{TERM}=sub { POSIX::setsid() >= 0 or die $!; $SIG{TERM}="IGNORE"; open(my $m, ">", "detached") or die $!; close($m); }; ${mark} while (1) { sleep 30 }`;
    const command = `trap ${shellQuote(`${waitForShell}; exit 0`)} TERM; perl -e ${shellQuote(perl)} </dev/null >/dev/null 2>&1 & wait`;
    await withStep(command, async (step, dir) => {
      await waitForFile(dir, "ready");
      const pid = childPid(dir);
      await ageChild(pid);
      const original = snapshotProcessTable().find((row) => row.pid === pid);
      expect(original?.pgid).toBe(step.pid);
      const exited = once(step, "exit");
      const stopped = stopSteps(1_500);
      await waitForFile(dir, "detached");
      writeFileSync(join(dir, "leave"), "");
      await exited;
      expect(await stopped).toBe(false);
      expect(await pidGone(pid)).toBe(false);
    });
  });
});
