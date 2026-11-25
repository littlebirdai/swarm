import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  createReplicationFollower,
  createReplicationHost,
  type ReplicationChannel,
  type ReplicationMessage,
} from "@platform/engine";
import { CACHE_SCHEMA_VERSION } from "../idb-cache";
import {
  replicationChannelName,
  replicationLockName,
  replicationTransport,
  scopedHostChannel,
} from "../storage-transport";
import {
  replicationHostFor,
  startSyncReplication,
  stopSyncReplication,
} from "../sync-replication";
import { session } from "./bucketFixtures";
import { replaceGlobals } from "../../test-helpers/globals";
import { startTestClock } from "../../test-helpers/testTimers";
import { useInboxStore } from "../inboxStore";

// Replication is scoped to the account a window acts for: channel and lock
// names carry the principal, so a host and its followers share one account
// by construction and a window that signed in as someone else hears nothing
// from the previous account's host.

describe("replication names", () => {
  it("carry the principal", () => {
    expect(replicationChannelName("userA")).toBe(
      `codecast-replication-v1:${CACHE_SCHEMA_VERSION}:userA`,
    );
    expect(replicationLockName("userA")).toBe(
      `codecast-sync-host:${CACHE_SCHEMA_VERSION}:userA`,
    );
    expect(replicationChannelName("userA")).not.toBe(
      replicationChannelName("userB"),
    );
  });
});

// A BroadcastChannel-like hub: channels with the same name see each other's
// posts, a closed channel neither sends nor receives.
function makeHub() {
  const opened: string[] = [];
  const posted: { name: string; data: unknown }[] = [];
  const locks: string[] = [];
  const members = new Map<string, Set<(e: MessageEvent) => void>>();
  class FakeBroadcastChannel {
    private own = new Set<(e: MessageEvent) => void>();
    private closed = false;
    constructor(public name: string) {
      opened.push(name);
    }
    postMessage(data: unknown) {
      if (this.closed) return;
      posted.push({ name: this.name, data });
      for (const fn of members.get(this.name) ?? []) {
        if (this.own.has(fn)) continue;
        queueMicrotask(() =>
          fn({ data: structuredClone(data) } as MessageEvent),
        );
      }
    }
    addEventListener(_t: string, fn: (e: MessageEvent) => void) {
      this.own.add(fn);
      if (!members.has(this.name)) members.set(this.name, new Set());
      members.get(this.name)!.add(fn);
    }
    removeEventListener(_t: string, fn: (e: MessageEvent) => void) {
      this.own.delete(fn);
      members.get(this.name)?.delete(fn);
    }
    close() {
      this.closed = true;
      for (const fn of this.own) members.get(this.name)?.delete(fn);
      this.own.clear();
    }
  }
  const lockManager = {
    request: (name: string, _opts: unknown, cb: () => unknown) => {
      locks.push(name);
      return Promise.resolve().then(() => cb());
    },
  };
  return { opened, posted, locks, FakeBroadcastChannel, lockManager };
}

describe("startSyncReplication", () => {
  const g = globalThis as any;
  let saved: Record<string, unknown>;
  let hub: ReturnType<typeof makeHub>;
  beforeEach(() => {
    hub = makeHub();
    saved = {
      window: g.window,
      BroadcastChannel: g.BroadcastChannel,
      navigator: g.navigator,
    };
    g.window = g.window ?? globalThis;
    g.BroadcastChannel = hub.FakeBroadcastChannel;
    g.navigator = { ...(g.navigator ?? {}), locks: hub.lockManager };
  });
  afterEach(() => {
    stopSyncReplication();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete g[k];
      else g[k] = v;
    }
  });

  it("does nothing for a window with no account", () => {
    const stop = startSyncReplication({ eligible: true, principalId: null });
    expect(hub.opened).toEqual([]);
    expect(hub.locks).toEqual([]);
    expect(useInboxStore.getState().syncRole).toBe("host");
    stop();
  });

  it("opens the account's channel and requests the account's lock", async () => {
    startSyncReplication({ eligible: true, principalId: "userA" });
    await new Promise((r) => setTimeout(r, 0));
    // The account's shared channel, and this window's own for snapshots addressed to it.
    expect(hub.opened).toHaveLength(3);
    expect(hub.opened[0]).toBe(replicationChannelName("userA"));
    expect(hub.opened[1]).toStartWith(`${replicationChannelName("userA")}:to:`);
    expect(hub.opened).toContain(`${replicationChannelName("userA")}:scope`);
    expect(hub.locks).toEqual([replicationLockName("userA")]);
    expect((window as any).__syncReplication().principalId).toBe("userA");
  });

  it("scoped windows never take the host lock, even when eligible", () => {
    startSyncReplication({
      eligible: true,
      principalId: "userA",
      keys: ["sessions"],
    });
    expect(hub.locks).toEqual([]);
  });

  it("scopes joins, filters live rows, and retains updates during a snapshot", async () => {
    const name = replicationChannelName("userA");
    const transport = replicationTransport(name, "host");
    const scoped = scopedHostChannel(name, "host", transport.channel);
    const docs = Object.fromEntries(
      Array.from({ length: 260 }, (_, i) => {
        const doc = { _id: `doc-${i}`, title: "Initial doc" };
        return [doc._id, doc];
      }),
    );
    const task = { _id: "unrelated", title: "Unrelated task" };
    let state = { docs, tasks: { unrelated: task } };
    const host = replicationHostFor("host", scoped.channel, () => state);
    const joined = Promise.withResolvers<void>();
    const unsubscribe = useInboxStore.subscribe((next) => {
      if (next.syncRole === "follower") joined.resolve();
    });
    const stop = startSyncReplication({
      eligible: false,
      principalId: "userA",
      keys: ["docs"],
    });
    const addressedFrames = () =>
      hub.posted
        .filter(({ name: address }) => address.startsWith(`${name}:scope:`))
        .map(({ data }) => data as ReplicationMessage);
    try {
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      expect(
        addressedFrames().some(
          (frame) => frame.type === "snapshotChunk" && !frame.done,
        ),
      ).toBe(true);
      const current = { ...docs["doc-259"], title: "Newer doc" };
      state = {
        docs: { ...docs, "doc-259": current },
        tasks: { unrelated: { ...task, title: "Changed" } },
      };
      host.tee(
        [
          { op: "replace", path: ["docs"], value: state.docs },
          { op: "replace", path: ["tasks"], value: state.tasks },
        ],
        state,
      );
      await joined.promise;
      expect(useInboxStore.getState().docs["doc-259"]?.title).toBe("Newer doc");
      expect(useInboxStore.getState().tasks.unrelated).toBeUndefined();
      const keys = addressedFrames().flatMap((frame) =>
        frame.type === "snapshotChunk" || frame.type === "update"
          ? frame.updates.map(({ key }) => key)
          : [],
      );
      expect(keys).toEqual(["docs", "docs", "docs"]);
    } finally {
      unsubscribe();
      stop();
      host.stop();
      scoped.close();
      transport.close();
      useInboxStore.setState({ docs: {}, tasks: {} });
    }
  });

  it("a duplicate legacy hello cannot widen a registered scoped snapshot", async () => {
    const name = replicationChannelName("userA");
    const transport = replicationTransport(name, "host");
    const scoped = scopedHostChannel(name, "host", transport.channel);
    const host = replicationHostFor("host", scoped.channel, () => ({
      sessions: { held: session("held") },
      tasks: { unrelated: { _id: "unrelated" } },
    }));
    const control = new hub.FakeBroadcastChannel(`${name}:scope`);
    const legacy = replicationTransport(name, "follower");
    try {
      control.postMessage({
        type: "hello",
        from: "follower",
        keys: ["sessions"],
        snapshotRequest: "join",
      });
      legacy.channel.post({
        type: "hello",
        from: "follower",
        snapshotRequest: "join",
      });
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      const frames = hub.posted.filter(
        ({ name: address }) => address === `${name}:scope:follower`,
      );
      expect(
        frames.map(({ data }) =>
          (data as { updates: { key: string }[] }).updates.map(
            ({ key }) => key,
          ),
        ),
      ).toEqual([["sessions"]]);
    } finally {
      control.close();
      legacy.close();
      host.stop();
      scoped.close();
      transport.close();
    }
  });

  it("a scoped optimistic edit reaches the modern host", async () => {
    const name = replicationChannelName("userA");
    const transport = replicationTransport(name, "host");
    const scoped = scopedHostChannel(name, "host", transport.channel);
    const received = Promise.withResolvers<unknown>();
    const held = session("held", { title: "Before edit" });
    const host = createReplicationHost({
      hostId: "host",
      channel: scoped.channel,
      getState: () => ({ sessions: { held } }),
      replicatedKeys: ["sessions"],
      isCollectionKey: () => true,
      applyUpdates: (updates) => received.resolve(updates),
    });
    const joined = Promise.withResolvers<void>();
    const off = useInboxStore.subscribe((next) => {
      if (next.syncRole === "follower") joined.resolve();
    });
    const stop = startSyncReplication({
      eligible: false,
      principalId: "userA",
      keys: ["sessions"],
    });
    useInboxStore.getState()._setDispatch(async () => null);
    try {
      await joined.promise;
      useInboxStore.getState().renameSession("held", "After edit");
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      expect(
        hub.posted.some(
          ({ name: address, data }) =>
            address === `${name}:scope` &&
            (data as ReplicationMessage).type === "mut",
        ),
      ).toBe(true);
      expect(await received.promise).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: "sessions",
            fields: { held: { title: "After edit" } },
          }),
        ]),
      );
    } finally {
      off();
      stop();
      host.stop();
      scoped.close();
      transport.close();
      useInboxStore.getState()._setDispatch(null);
      useInboxStore.setState({ sessions: {}, pending: {} });
    }
  });

  it("rejoins when a pause expires the scoped peer", async () => {
    const heartbeat = spyOn(globalThis, "setInterval");
    const time = spyOn(Date, "now");
    const name = replicationChannelName("userA");
    const transport = replicationTransport(name, "host");
    const scoped = scopedHostChannel(name, "host", transport.channel);
    let held = session("held", { title: "Before pause" });
    const host = replicationHostFor("host", scoped.channel, () => ({
      sessions: { held },
    }));
    const joined = Promise.withResolvers<void>();
    const rejoined = Promise.withResolvers<void>();
    const off = useInboxStore.subscribe((next) => {
      if (next.syncRole !== "follower") return;
      if (next.sessions.held?.title === "Before pause") joined.resolve();
      if (next.sessions.held?.title === "After pause") rejoined.resolve();
    });
    const stop = startSyncReplication({
      eligible: false,
      principalId: "userA",
      keys: ["sessions"],
    });
    try {
      await joined.promise;
      held = { ...held, title: "After pause" };
      time.mockReturnValue(Date.now() + 7_000);
      heartbeat.mock.calls[0]![0]();
      await rejoined.promise;
      expect(useInboxStore.getState().sessions.held?.title).toBe("After pause");
    } finally {
      off();
      stop();
      host.stop();
      scoped.close();
      transport.close();
      useInboxStore.setState({ sessions: {} });
      time.mockRestore();
      heartbeat.mockRestore();
    }
  });

  it.each(["modern", "legacy", "absent"] as const)(
    "the palette recovers when its replacement is %s",
    async (replacement) => {
      const clock = startTestClock();
      const restore = replaceGlobals({
        window: {
          location: { pathname: "/palette" },
          __CODECAST_ELECTRON__: {},
        },
      });
      const name = replicationChannelName("userA");
      const serve = (id: string, modern: boolean) => {
        const transport = replicationTransport(name, id);
        const scoped = modern && scopedHostChannel(name, id, transport.channel);
        const row = session("held", { title: id });
        const host = replicationHostFor(
          id,
          scoped ? scoped.channel : transport.channel,
          () => ({
            sessions: { held: row },
            commits: { commit: { _id: "commit", message: id } },
          }),
        );
        return () => {
          host.stop();
          if (scoped) scoped.close();
          transport.close();
        };
      };
      const original = serve("original host", true);
      const stop = startSyncReplication({
        eligible: false,
        principalId: "userA",
      });
      let closeReplacement: (() => void) | undefined;
      try {
        await clock.advance(0);
        expect(useInboxStore.getState().sessions.held?.title).toBe(
          "original host",
        );
        expect(useInboxStore.getState().commits.commit?.message).toBe(
          "original host",
        );
        expect(useInboxStore.getState().syncRole).toBe("follower");
        original();
        hub.posted.length = 0;
        if (replacement !== "absent")
          closeReplacement = serve(
            "replacement host",
            replacement === "modern",
          );

        if (replacement === "modern") {
          await clock.advance(0);
          expect(
            hub.posted.some(
              ({ data }) => (data as { type: string }).type === "rejoin",
            ),
          ).toBe(false);
        } else {
          await clock.advance(5_999);
          expect(hub.posted).toEqual([]);
          expect(useInboxStore.getState().syncRole).toBe("follower");
          await clock.advance(1);
        }

        const hellos = hub.posted.filter(
          ({ data }) => (data as ReplicationMessage).type === "hello",
        );
        const snapshots = hub.posted.filter(({ data }) => {
          const message = data as ReplicationMessage;
          return (
            message.type === "snapshot" ||
            (message.type === "snapshotChunk" && message.done)
          );
        });
        const role = () => useInboxStore.getState().syncRole;
        expect(role()).toBe("follower");
        if (replacement === "absent") {
          expect(snapshots).toHaveLength(0);
          await clock.advance(7_999);
          expect(role()).toBe("follower");
          await clock.advance(1);
          expect(role()).toBe("host");
        } else {
          expect(snapshots).toHaveLength(1);
          expect(useInboxStore.getState().sessions.held?.title).toBe(
            "replacement host",
          );
          expect(useInboxStore.getState().commits.commit?.message).toBe(
            "replacement host",
          );
        }
        expect(hellos).toHaveLength(1);
      } finally {
        stop();
        original();
        closeReplacement?.();
        useInboxStore.setState({ sessions: {}, commits: {} });
        restore();
        clock.close();
      }
    },
  );

  it("reads from a legacy host and sends local field writes on the legacy channel", async () => {
    const name = replicationChannelName("userA");
    const transport = replicationTransport(name, "legacy-host");
    const held = session("held", { title: "Legacy session" });
    const received = Promise.withResolvers<ReplicationMessage>();
    const off = transport.channel.onMessage((message) => {
      if (message.type === "mut") received.resolve(message);
    });
    const host = createReplicationHost({
      hostId: "legacy-host",
      channel: transport.channel,
      getState: () => ({
        sessions: { held },
        tasks: { unrelated: { _id: "unrelated", title: "Unrelated task" } },
      }),
      replicatedKeys: ["sessions", "tasks"],
      isCollectionKey: () => true,
      applyUpdates: () => {},
    });
    const joined = Promise.withResolvers<void>();
    const unsubscribe = useInboxStore.subscribe((next) => {
      if (next.syncRole === "follower") joined.resolve();
    });
    const stop = startSyncReplication({
      eligible: false,
      principalId: "userA",
      keys: ["sessions"],
    });
    const dispatch = Promise.withResolvers<string>();
    useInboxStore.getState()._setDispatch(async (action) => {
      dispatch.resolve(action);
      return null;
    });
    try {
      await joined.promise;
      expect(useInboxStore.getState().sessions.held?.title).toBe(
        "Legacy session",
      );
      expect(useInboxStore.getState().tasks.unrelated).toBeUndefined();
      const changed = { ...held, title: "Live from legacy" };
      host.tee(
        [
          { op: "replace", path: ["sessions", "held"], value: changed },
          {
            op: "replace",
            path: ["tasks", "unrelated"],
            value: { _id: "unrelated", title: "Changed" },
          },
        ],
        {
          sessions: { held: changed },
          tasks: { unrelated: { _id: "unrelated", title: "Changed" } },
        },
      );
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      expect(useInboxStore.getState().sessions.held?.title).toBe(
        "Live from legacy",
      );
      expect(useInboxStore.getState().tasks.unrelated).toBeUndefined();
      useInboxStore.getState().renameSession("held", "Renamed by follower");
      const mut = await received.promise;
      expect(mut.type === "mut" && mut.updates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: "sessions",
            fields: { held: { title: "Renamed by follower" } },
          }),
        ]),
      );
      expect(await dispatch.promise).toBe("renameSession");
    } finally {
      stop();
      unsubscribe();
      off();
      host.stop();
      transport.close();
      useInboxStore.getState()._setDispatch(null);
      useInboxStore.setState({
        sessions: {},
        conversations: {},
        tasks: {},
        pending: {},
      });
    }
  });

  it("a legacy follower receives the full snapshot and stream from a modern host", async () => {
    const name = replicationChannelName("userA");
    const transport = replicationTransport(name, "host");
    const scoped = scopedHostChannel(name, "host", transport.channel);
    const held = session("held", { title: "Session" });
    const task = { _id: "unrelated", title: "Task" };
    const state = { sessions: { held }, tasks: { unrelated: task } };
    const host = replicationHostFor("host", scoped.channel, () => state);
    const old = replicationTransport(name, "legacy-follower");
    const joined = Promise.withResolvers<void>();
    const updates: string[] = [];
    const follower = createReplicationFollower({
      selfId: "legacy-follower",
      channel: old.channel,
      replicatedKeys: ["sessions", "tasks"],
      isCollectionKey: () => true,
      applyUpdates: (rows) => updates.push(...rows.map(({ key }) => key)),
      onSynced: (synced) => {
        if (synced) joined.resolve();
      },
    });
    try {
      await joined.promise;
      expect(updates.sort()).toEqual(["sessions", "tasks"]);
      const live = Promise.withResolvers<void>();
      const unsubscribe = old.channel.onMessage((message) => {
        if (message.type === "update") live.resolve();
      });
      try {
        host.tee(
          [{ op: "replace", path: ["tasks", "unrelated"], value: task }],
          state,
        );
        await live.promise;
        expect(updates[2]).toBe("tasks");
      } finally {
        unsubscribe();
      }
    } finally {
      follower.stop();
      old.close();
      host.stop();
      scoped.close();
      transport.close();
    }
  });

  it("stopSyncReplication ends the old account's transport and leaves the window a host", async () => {
    startSyncReplication({ eligible: false, principalId: "userA" });
    stopSyncReplication();
    // A fresh start for the next account opens that account's channel, not the old one.
    startSyncReplication({ eligible: false, principalId: "userB" });
    expect(hub.opened.filter((n) => !n.includes(":to:"))).toEqual([
      replicationChannelName("userA"),
      replicationChannelName("userB"),
    ]);
    expect(useInboxStore.getState().syncRole).toBe("host");
  });
});

// Two windows on the engine runtimes: a host for account A, a follower that
// signed in as account B. Distinct channel names mean the follower never
// syncs from A's host, and a late message from A's host after the follower
// re-keyed lands nowhere because its old channel is closed.
describe("host and follower of different accounts", () => {
  function channelFor(
    hub: ReturnType<typeof makeHub>,
    name: string,
  ): {
    channel: ReplicationChannel;
    bc: InstanceType<typeof hub.FakeBroadcastChannel>;
  } {
    const bc = new hub.FakeBroadcastChannel(name);
    return {
      bc,
      channel: {
        post: (msg: ReplicationMessage) => bc.postMessage(msg),
        onMessage: (cb) => {
          const handler = (e: MessageEvent) => cb(e.data);
          bc.addEventListener("message", handler);
          return () => bc.removeEventListener("message", handler);
        },
      },
    };
  }
  const settle = () => new Promise((r) => setTimeout(r, 5));

  it("never sync, and a follower that switches accounts drops the old host's stream", async () => {
    const hub = makeHub();
    const state = { sessions: { s1: { _id: "s1", title: "account A's row" } } };
    const hostA = createReplicationHost({
      hostId: "hostA",
      channel: channelFor(hub, replicationChannelName("userA")).channel,
      getState: () => state,
      replicatedKeys: ["sessions"],
      isCollectionKey: () => true,
      applyUpdates: () => {},
    });
    const appliedB: unknown[] = [];
    const followerB = createReplicationFollower({
      selfId: "winB",
      channel: channelFor(hub, replicationChannelName("userB")).channel,
      replicatedKeys: ["sessions"],
      isCollectionKey: () => true,
      applyUpdates: (u) => appliedB.push(u),
      helloRetryMs: 1,
    });
    await settle();
    expect(followerB.synced()).toBe(false);
    expect(appliedB).toEqual([]);

    // The same window as account A does sync, so the test proves scoping, not a dead harness.
    const appliedA: unknown[] = [];
    const winOnA = channelFor(hub, replicationChannelName("userA"));
    const followerA = createReplicationFollower({
      selfId: "winA",
      channel: winOnA.channel,
      replicatedKeys: ["sessions"],
      isCollectionKey: () => true,
      applyUpdates: (u) => appliedA.push(u),
      helloRetryMs: 1,
    });
    await settle();
    expect(followerA.synced()).toBe(true);
    expect(JSON.stringify(appliedA)).toContain("account A's row");

    // That window signs in as account B: its old channel closes with its follower.
    followerA.stop();
    winOnA.bc.close();
    const before = appliedA.length;
    state.sessions = { s2: { _id: "s2", title: "late row from A" } } as any;
    hostA.tee(
      [{ op: "replace", path: ["sessions"], value: state.sessions }] as any,
      state,
    );
    await settle();
    expect(appliedA.length).toBe(before);
    followerB.stop();
    hostA.stop();
  });
});

// A snapshot is ~100 MB in a real store and every window that receives one
// pays to decode it. It must reach only the window that asked, while the
// live update stream still reaches everyone.
describe("replicationTransport", () => {
  const g = globalThis as any;
  let saved: unknown;
  let hub: ReturnType<typeof makeHub>;
  beforeEach(() => {
    hub = makeHub();
    saved = g.BroadcastChannel;
    g.BroadcastChannel = hub.FakeBroadcastChannel;
  });
  afterEach(() => {
    if (saved === undefined) delete g.BroadcastChannel;
    else g.BroadcastChannel = saved;
  });
  const settle = () => new Promise((r) => setTimeout(r, 5));

  it("delivers a snapshot only to the follower that asked, and updates to all", async () => {
    const name = replicationChannelName("userA");
    const state: any = { sessions: { s1: { _id: "s1", title: "first" } } };
    const hostT = replicationTransport(name, "host");
    const host = createReplicationHost({
      hostId: "host",
      channel: hostT.channel,
      getState: () => state,
      replicatedKeys: ["sessions"],
      isCollectionKey: () => true,
      applyUpdates: () => {},
    });
    const seen: Record<string, ReplicationMessage[]> = { a: [], b: [] };
    const followers = (["a", "b"] as const).map((id) => {
      const t = replicationTransport(name, id);
      t.channel.onMessage((m) => seen[id].push(m));
      return {
        t,
        f: createReplicationFollower({
          selfId: id,
          channel: t.channel,
          replicatedKeys: ["sessions"],
          isCollectionKey: () => true,
          applyUpdates: () => {},
          helloRetryMs: 1000,
        }),
      };
    });
    await settle();
    expect(followers.every(({ f }) => f.synced())).toBe(true);
    const snapshotsTo = (id: string) =>
      seen[id].filter(
        (m) => m.type === "snapshot" || m.type === "snapshotChunk",
      );
    expect(snapshotsTo("a").length).toBeGreaterThan(0);
    expect(snapshotsTo("a").every((m: any) => m.to === "a")).toBe(true);
    expect(snapshotsTo("b").every((m: any) => m.to === "b")).toBe(true);

    state.sessions = { ...state.sessions, s2: { _id: "s2", title: "second" } };
    host.tee(
      [
        { op: "add", path: ["sessions", "s2"], value: state.sessions.s2 },
      ] as any,
      state,
    );
    await settle();
    for (const id of ["a", "b"])
      expect(seen[id].some((m) => m.type === "update")).toBe(true);
    expect(followers.every(({ f }) => f.synced())).toBe(true);

    for (const { t, f } of followers) {
      f.stop();
      t.close();
    }
    host.stop();
    hostT.close();
  });
});
