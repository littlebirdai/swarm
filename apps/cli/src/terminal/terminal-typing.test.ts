import { expect, test } from "bun:test";
import {
  PANE_HEARTBEAT_MS,
  PANE_INPUT_POLL_MS,
} from "@codecast/daemon/terminalStream";
import {
  startTerminalTyping,
  type TerminalTypingTransport,
} from "./terminal-typing.js";
import type { TypingPane } from "./tmux-typing-pane.js";

const binding = {
  conversation_id: "conversation",
  tmux_session: "cc-typing",
  agent_started_at: 10,
};
const firstPane: TypingPane = {
  socket: "/tmp/fake-tmux",
  serverPid: "29",
  paneId: "%0",
  panePid: "30",
  watchIdentity: "cc-typing|1|29|%0|30|0",
};
const replacement = {
  ...firstPane,
  panePid: "31",
  watchIdentity: "cc-typing|1|29|%0|31|0",
};

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function clock() {
  let now = 0;
  const timers = new Map<() => void, number>();
  return {
    now: () => now,
    sleep(ms: number, signal: AbortSignal) {
      return new Promise<void>((resolve) => {
        const wake = () => {
          timers.delete(wake);
          signal.removeEventListener("abort", wake);
          resolve();
        };
        if (signal.aborted) return wake();
        timers.set(wake, now + ms);
        signal.addEventListener("abort", wake, { once: true });
      });
    },
    async advance(ms: number) {
      now += ms;
      for (const [wake, due] of timers) if (due <= now) wake();
      await flush();
    },
  };
}

type Poll = Parameters<TerminalTypingTransport["poll"]>[0];
type Reply = Awaited<ReturnType<TerminalTypingTransport["poll"]>>;
const input = (data: string, pane_instance = 1, token = 7) => ({
  data,
  pane_instance,
  token,
});
const control = (
  pane_instance = 1,
  sequence = 1,
  token: number | null = 7,
) => ({
  pane_instance,
  sequence,
  token,
});

function rig(initialInstance = 0) {
  let instance = initialInstance;
  let pane: TypingPane | null = firstPane;
  let onPoll: (args: Poll) => Reply | Promise<Reply> = ({ pane_instance }) => ({
    status: "ok",
    control: control(pane_instance),
  });
  const time = clock();
  const reports: Parameters<TerminalTypingTransport["report"]>[0][] = [];
  const polls: Poll[] = [];
  const keys: number[][] = [];
  const nativeCalls: string[] = [];
  const catalogCalls: string[] = [];
  let rows = [binding];
  const transport: TerminalTypingTransport = {
    async catalog() {
      catalogCalls.push("catalog");
      return rows;
    },
    async report(args) {
      reports.push(args);
      return {
        status: "ok",
        last_pane_instance:
          args.observation === "started" ? ++instance : instance,
      };
    },
    async poll(args) {
      polls.push(args);
      return onPoll(args);
    },
  };
  return {
    start: (enabled = true) =>
      startTerminalTyping(enabled, {
        ...transport,
        now: time.now,
        sleep: time.sleep,
        async resolve(target) {
          nativeCalls.push(target);
          return pane;
        },
        async write(_target, _pane, bytes) {
          keys.push([...bytes]);
          return true;
        },
      }),
    pollAfter: () => time.advance(PANE_INPUT_POLL_MS),
    advance: time.advance,
    reports,
    polls,
    keys,
    nativeCalls,
    catalogCalls,
    setPane(value: TypingPane | null) {
      pane = value;
    },
    setRows(value: typeof rows) {
      rows = value;
    },
    reply(value: typeof onPoll) {
      onPoll = value;
    },
  };
}

test("flag off leaves the transport and tmux untouched", async () => {
  const f = rig();
  const stop = f.start(false);
  await f.advance(PANE_HEARTBEAT_MS);
  await stop();
  expect(f.catalogCalls).toEqual([]);
  expect(f.reports).toEqual([]);
  expect(f.polls).toEqual([]);
  expect(f.nativeCalls).toEqual([]);
});

test("writes drained batches in order after acknowledging control, once per response", async () => {
  const f = rig();
  f.reply(() => ({ status: "ok", control: control(), input: input("ff") }));
  const stop = f.start();
  try {
    await flush();
    expect(f.reports).toMatchObject([
      {
        pane_instance: 0,
        observation: "started",
        watch_pane_instance: firstPane.watchIdentity,
      },
    ]);
    expect(f.polls[0]).not.toHaveProperty("ack");
    expect(f.keys).toEqual([]);
    const replies = ["611b", "61", "61"];
    f.reply(() => {
      const data = replies.shift();
      return {
        status: "ok",
        control: control(),
        ...(data && { input: input(data) }),
      };
    });
    for (let i = 0; i < 4; i++) await f.pollAfter();
    expect(f.polls.slice(1)).toEqual(
      Array(4).fill({
        conversation_id: binding.conversation_id,
        agent_started_at: 10,
        pane_instance: 1,
        ack: { sequence: 1, token: 7 },
      }),
    );
    expect(f.keys).toEqual([[97, 27], [97], [97]]);
  } finally {
    await stop();
  }
  expect(f.reports.at(-1)).toMatchObject({
    pane_instance: 1,
    observation: "ended",
  });
});

test("rejects stale token, pane, and control and takes a new acknowledgement after a stale poll", async () => {
  const f = rig();
  const stop = f.start();
  try {
    await flush();
    const changed = control(1, 2, 8);
    const replies: Reply[] = [
      { status: "stale" },
      { status: "ok", control: changed, input: input("ee", 1, 8) },
      { status: "ok", control: changed, input: input("ff") },
      { status: "ok", control: changed, input: input("ff", 2, 8) },
      { status: "ok", control: control(), input: input("ee") },
      { status: "ok", control: changed, input: input("62", 1, 8) },
    ];
    f.reply(() => replies.shift()!);
    for (let i = 0; i < 5; i++) await f.pollAfter();
    expect(f.polls[2]).not.toHaveProperty("ack");
    expect(f.polls.slice(3)).toHaveLength(3);
    expect(f.keys).toEqual([]);
    await f.advance(PANE_HEARTBEAT_MS);
    expect(f.polls.at(-1)?.ack).toEqual({ sequence: 2, token: 8 });
    expect(f.keys).toEqual([[98]]);
  } finally {
    await stop();
  }
});

test.each(["ended", "replaced"] as const)(
  "drops a drained batch when the pane %s during the poll",
  async (change) => {
    const f = rig();
    const stop = f.start();
    try {
      await flush();
      f.reply(() => {
        f.setPane(change === "ended" ? null : replacement);
        return { status: "ok", control: control(), input: input("ff") };
      });
      await f.pollAfter();
      expect(f.keys).toEqual([]);
      expect(f.reports.at(-1)).toMatchObject({
        observation: "ended",
        pane_instance: 1,
      });
      f.reply(({ pane_instance }) => ({
        status: "ok",
        control: control(pane_instance, 2, 9),
      }));
      await f.pollAfter();
      if (change === "replaced") {
        expect(f.reports.at(-1)).toMatchObject({
          observation: "started",
          pane_instance: 0,
          watch_pane_instance: replacement.watchIdentity,
        });
        expect(f.polls.at(-1)).toMatchObject({ pane_instance: 2 });
      } else {
        expect(f.reports).toHaveLength(2);
      }
    } finally {
      await stop();
    }
  },
);

test("a daemon stop discards an in-flight response and restart uses a new instance", async () => {
  const f = rig(40);
  const stop = f.start();
  await flush();
  const inFlight = Promise.withResolvers<Reply>();
  f.reply(() => inFlight.promise);
  await f.pollAfter();
  const stopping = stop();
  inFlight.resolve({
    status: "ok",
    control: control(41),
    input: input("ff", 41),
  });
  await stopping;
  expect(f.keys).toEqual([]);
  expect(f.reports.at(-1)).toMatchObject({
    pane_instance: 41,
    observation: "ended",
  });

  f.reply(() => ({ status: "ok", control: control(42, 2, 8) }));
  const stopRestarted = f.start();
  try {
    await flush();
    expect(f.polls.at(-1)).toMatchObject({ pane_instance: 42 });
    expect(f.polls.at(-1)).not.toHaveProperty("ack");
    f.reply(() => ({
      status: "ok",
      control: control(42, 2, 8),
      input: input("63", 42, 8),
    }));
    await f.pollAfter();
    expect(f.keys).toEqual([[99]]);
  } finally {
    await stopRestarted();
  }
});

test("two recorded aliases of one physical tmux pane have one report and poll", async () => {
  const f = rig();
  f.setRows([
    binding,
    { ...binding, conversation_id: "alias", tmux_session: "cc-typing:0.0" },
  ]);
  const stop = f.start();
  try {
    await flush();
    expect(f.nativeCalls).toEqual(["cc-typing", "cc-typing:0.0"]);
    expect(f.reports).toHaveLength(1);
    expect(f.polls).toHaveLength(1);
  } finally {
    await stop();
  }
});

test("daemon flag off does not construct a Convex client", async () => {
  const { startDaemonTerminalTyping } =
    await import("./daemon-terminal-typing.js");
  const old = process.env.CODECAST_TERMINAL_TYPING;
  delete process.env.CODECAST_TERMINAL_TYPING;
  try {
    expect(
      startDaemonTerminalTyping("not-a-deployment-url", "test-token", () => {}),
    ).toBeUndefined();
  } finally {
    if (old !== undefined) process.env.CODECAST_TERMINAL_TYPING = old;
  }
});
