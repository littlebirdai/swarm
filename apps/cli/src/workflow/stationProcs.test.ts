import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { snapshotProcessTable } from "../processTable.js";
import {
  isolateCodecastDir,
  type IsolatedCodecastDir,
} from "../test-helpers/codecastDir.js";
import { pollUntil } from "../test-helpers/pollUntil.js";
import { stillRunning } from "../test-helpers/processLiveness.js";
import {
  bootTimeMs,
  reapDeadRunnerStations,
  stationRecordDir,
} from "./stationProcs";

let home: IsolatedCodecastDir;
let tmp = "";
beforeAll(() => {
  home = isolateCodecastDir();
});
afterAll(() => home.restore());

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const pidsIn = (file: string) =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, "utf-8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(Number)
    : [];
const strays: number[] = [];
const graceMs = 500;
afterEach(() => {
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = "";
  fs.rmSync(stationRecordDir(), { recursive: true, force: true });
});

describe("a dead runner's record", () => {
  const deadPid = async () => {
    const p = Bun.spawn(["true"]);
    await p.exited;
    return p.pid;
  };
  const writeRecord = (runner: number, written: number, groups: unknown[]) => {
    fs.mkdirSync(stationRecordDir(), { recursive: true });
    const file = path.join(stationRecordDir(), `${runner}.json`);
    fs.writeFileSync(file, JSON.stringify({ runner, written, groups }));
    return file;
  };
  const rowOf = (pid: number) =>
    snapshotProcessTable().find((p) => p.pid === pid);

  const oldStart = "Wed Jan 1 00:00:00 2020";
  const freshStart = "Wed Jan 1 00:00:01 2020";
  const group = 1000000000;
  const child = group + 1;
  const tree = [
    `${group} 1 ${group} 0 ? ${freshStart} shell`,
    `${child} ${group} ${child} 0 ? ${oldStart} child`,
  ].join("\n");

  function withProcessReads(
    reads: readonly (string | null)[],
    run: string,
  ): string {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "station-reads-"));
    const ps = path.join(tmp, "ps");
    fs.writeFileSync(
      ps,
      `#!${process.execPath}
import * as fs from "node:fs";
if (process.argv[2] !== "-axww") process.exit(1);
const count = ${JSON.stringify(path.join(tmp, "reads"))};
const n = fs.existsSync(count) ? Number(fs.readFileSync(count, "utf8")) : 0;
fs.writeFileSync(count, String(n + 1));
const table = ${JSON.stringify(reads)}[n];
if (!table) process.exit(1);
console.log(table);
`,
      { mode: 0o755 },
    );
    const proc = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        `
import * as station from ${JSON.stringify(path.join(import.meta.dir, "stationProcs.ts"))};
Date.now = () => Date.parse("2020-01-01T00:00:01Z");
const signals = [];
process.kill = (pid, sig) => {
  if (sig === "SIGTERM") {
    signals.push(pid);
    return true;
  }
  throw Object.assign(new Error("No such process"), { code: "ESRCH" });
};
${run}
`,
      ],
      {
        env: { ...process.env, PATH: `${tmp}:${process.env.PATH}`, TZ: "UTC" },
      },
    );
    if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
    return proc.stdout.toString().trim();
  }

  test("uses the first exit read for TERM if the second read fails", () => {
    const actual = withProcessReads(
      [tree, null],
      `
      station.endStationsOnExit([${group}], 0);
      console.log(signals.includes(${child}));
    `,
    );
    expect(actual).toBe("true");
  });

  test.each([null, tree])(
    "reports incomplete exit cleanup if the second read fails or gives partial proof (%#)",
    (second) => {
      const actual = withProcessReads(
        [tree, second],
        `
        console.log(station.endStationsOnExit([${group}], 0));
      `,
      );
      expect(actual).toBe("false");
    },
  );

  test("uses the first async tree read for TERM if the second read fails", () => {
    const actual = withProcessReads(
      [tree, null],
      `
      await station.endStation(${group}, 0);
      console.log(signals.includes(${child}));
    `,
    );
    expect(actual).toBe("true");
  });

  test("does not send TERM when the first async tree read fails", () => {
    const actual = withProcessReads(
      [null, tree],
      `
      await station.endStation(${group}, 0);
      console.log(signals.includes(${child}));
    `,
    );
    expect(actual).toBe("false");
  });

  test("keeps known process identities if the station read fails", () => {
    const known = [{ pid: child, pgid: child, start: oldStart }];
    const actual = withProcessReads(
      [null],
      `
      console.log(JSON.stringify(await station.readStationProcs(${group}, ${JSON.stringify(known)})));
    `,
    );
    expect(JSON.parse(actual)).toEqual(known);
  });

  test.each([
    { name: "initial read fails", reads: [null] },
    {
      name: "tree read fails",
      reads: [tree, null, `1 0 1 0 ? ${oldStart} init`],
    },
    { name: "confirmation read fails", reads: [tree, tree, null] },
    { name: "confirmation shows a live process", reads: [tree, tree, tree] },
  ])("keeps the runner record when $name", async ({ reads }) => {
    const file = writeRecord(await deadPid(), Date.now(), [
      { pgid: group, procs: [{ pid: child, pgid: child, start: oldStart }] },
    ]);
    try {
      const actual = withProcessReads(
        reads,
        `
        await station.reapDeadRunnerStations(${JSON.stringify(stationRecordDir())}, 0);
        console.log(require("node:fs").existsSync(${JSON.stringify(file)}));
      `,
      );
      expect(actual).toBe("true");
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  test("discards a malformed record without sending a signal", async () => {
    const runner = await deadPid();
    const file = writeRecord(runner, Date.now(), [
      { pgid: group, procs: [{ pid: child, pgid: child, start: oldStart }] },
      null,
    ]);
    const actual = withProcessReads(
      [tree, tree, tree],
      `
      await station.reapDeadRunnerStations(${JSON.stringify(stationRecordDir())}, 0);
      console.log(JSON.stringify({ signals, exists: require("node:fs").existsSync(${JSON.stringify(file)}) }));
    `,
    );
    expect(JSON.parse(actual)).toEqual({ signals: [], exists: false });
  });

  test("keeps a record that another runner wrote during cleanup", async () => {
    const runner = await deadPid();
    const written = Date.now();
    const file = writeRecord(runner, written, [
      { pgid: group, procs: [{ pid: child, pgid: child, start: oldStart }] },
    ]);
    const replacement = { runner, written: written + 1, groups: [] };
    const otherRow = `1 0 1 0 ? ${oldStart} init`;
    const actual = withProcessReads(
      [tree, tree, otherRow],
      `
      const kill = process.kill;
      const fs = require("node:fs");
      process.kill = (pid, sig) => {
        if (pid === ${child} && sig === "SIGTERM") {
          fs.writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(JSON.stringify(replacement))});
        }
        return kill(pid, sig);
      };
      await station.reapDeadRunnerStations(${JSON.stringify(stationRecordDir())}, 0);
      console.log(fs.readFileSync(${JSON.stringify(file)}, "utf-8"));
    `,
    );
    expect(JSON.parse(actual)).toEqual(replacement);
  });

  test.each([
    {
      name: "a target that changed groups",
      final: `${child} 1 ${child + 1} 0 ? ${oldStart} active`,
      removed: false,
    },
    {
      name: "a new child of the leader",
      final: `${group} 1 ${group} 0 ? ${oldStart} shell <defunct>\n${child + 1} ${group} ${group} 0 ? ${oldStart} active`,
      removed: false,
    },
    {
      name: "one zombie and one live target",
      final: `${group} 1 ${group} 0 ? ${oldStart} shell <defunct>\n${child} 1 ${child + 1} 0 ? ${oldStart} active`,
      removed: false,
    },
    {
      name: "only zombies",
      final: `${group} 1 ${group} 0 ? ${oldStart} shell <defunct>\n${child} 1 ${child} 0 ? ${oldStart} child <defunct>`,
      removed: true,
    },
  ])("confirms cleanup with $name", async ({ final, removed }) => {
    const file = writeRecord(await deadPid(), Date.now(), [
      { pgid: group, procs: [{ pid: group, pgid: group, start: oldStart }] },
    ]);
    const original = tree.replace(freshStart, oldStart);
    const actual = withProcessReads(
      [original, original, original, final],
      `
      await station.reapDeadRunnerStations(${JSON.stringify(stationRecordDir())}, 0);
      console.log(require("node:fs").existsSync(${JSON.stringify(file)}));
    `,
    );
    expect(actual).toBe(String(!removed));
  });

  test("sends TERM to the group of a proven leader and ends members from the next read", async () => {
    const file = writeRecord(await deadPid(), Date.now(), [
      { pgid: group, procs: [{ pid: group, pgid: group, start: oldStart }] },
    ]);
    const leader = `${group} 1 ${group} 0 ? ${oldStart} shell`;
    const fork = `${child} ${group} ${group} 0 ? ${oldStart} child`;
    const actual = withProcessReads(
      [leader, leader, `${leader}\n${fork}`, `1 0 1 0 ? ${oldStart} init`],
      `
      await station.reapDeadRunnerStations(${JSON.stringify(stationRecordDir())}, 0);
      console.log(JSON.stringify({ signals, exists: require("node:fs").existsSync(${JSON.stringify(file)}) }));
    `,
    );
    expect(JSON.parse(actual)).toEqual({
      signals: [-group, group, group, child],
      exists: false,
    });
  });

  test("ends a child the leader forks in its TERM handler", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "station-trap-"));
    const leader = Bun.spawn(
      [
        "perl",
        "-MPOSIX",
        "-e",
        `
        POSIX::setsid() >= 0 or die $!;
        sub mark {
          my ($name, $pid) = @_;
          open(my $f, ">", "$name.tmp") or die $!;
          print $f $pid;
          close($f);
          rename("$name.tmp", $name) or die $!;
        }
        my $forked = 0;
        $SIG{TERM} = sub {
          return if $forked++;
          my $child = fork();
          die $! if !defined($child);
          if (!$child) {
            $SIG{TERM} = sub { exit 0 };
            mark("child", $$);
            while (1) { sleep 30 }
          }
        };
        mark("leader", $$);
        while (1) { sleep 30 }
      `,
      ],
      { cwd: tmp, stdout: "ignore", stderr: "inherit" },
    );
    try {
      await pollUntil(
        () => {
          if (!fs.existsSync(path.join(tmp, "leader"))) return false;
          const row = rowOf(leader.pid);
          return (
            row?.pgid === leader.pid &&
            !!row.startedAt &&
            Date.parse(row.startedAt) < Math.floor(Date.now() / 1000) * 1000
          );
        },
        "the group leader with an established start time",
        { every: 50 },
      );
      const initial = rowOf(leader.pid)!;
      const file = writeRecord(await deadPid(), Date.now(), [
        {
          pgid: leader.pid,
          procs: [
            { pid: leader.pid, pgid: leader.pid, start: initial.startedAt },
          ],
        },
      ]);
      expect(await reapDeadRunnerStations(undefined, graceMs)).toEqual([
        leader.pid,
      ]);
      const child = pidsIn(path.join(tmp, "child"));
      expect(child).toHaveLength(1);
      expect(await stillRunning([leader.pid, ...child])).toEqual([]);
      expect(fs.existsSync(file)).toBe(false);
    } finally {
      strays.push(...pidsIn(path.join(tmp, "child")));
      leader.kill("SIGKILL");
      await leader.exited;
    }
  });

  test("is dropped unread when it was written before this boot, though it names a live process", async () => {
    const proc = Bun.spawn(
      ["perl", "-MPOSIX", "-e", "POSIX::setsid(); sleep 600"],
      { stdout: "ignore", stderr: "ignore" },
    );
    strays.push(proc.pid);
    await pollUntil(
      () => rowOf(proc.pid)?.pgid === proc.pid,
      "the process leading a group of its own",
      { ms: 5_000 },
    );
    const row = rowOf(proc.pid)!;
    const file = writeRecord(await deadPid(), bootTimeMs()! - 60_000, [
      {
        pgid: row.pgid,
        at: 0,
        procs: [{ pid: row.pid, pgid: row.pgid, start: row.startedAt }],
      },
    ]);
    expect(await reapDeadRunnerStations(undefined, graceMs)).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
    expect(alive(proc.pid)).toBe(true);
  });

  test("leaves alone a leaderless group of another program that took a recorded group id", async () => {
    const out = Bun.spawnSync([
      "perl",
      "-MPOSIX",
      "-e",
      `POSIX::setsid(); my $c = fork(); if (!$c) { open STDOUT, ">/dev/null"; open STDERR, ">/dev/null"; exec "sleep", "600" } print "$c\n"; exit 0`,
    ]);
    const member = Number(String(out.stdout).trim());
    strays.push(member);
    await pollUntil(
      () => {
        const r = rowOf(member);
        return !!r && r.pgid !== undefined && !alive(r.pgid);
      },
      "a group whose leader has exited",
      { ms: 5_000 },
    );
    const group = rowOf(member)!.pgid!;
    const file = writeRecord(await deadPid(), Date.now(), [
      {
        pgid: group,
        at: Date.now(),
        procs: [{ pid: group, pgid: group, start: "Thu Jan 1 00:00:00 1970" }],
      },
    ]);
    expect(await reapDeadRunnerStations(undefined, graceMs)).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
    expect(alive(member)).toBe(true);
  });
});
