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
  expandWindowReplication,
  replicationHostFor,
  startSyncReplication,
  stopSyncReplication,
} from "../sync-replication";
import { session } from "./bucketFixtures";
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

  it("scopes join and updates, and grows without a gap or stale overwrite", async () => {
    const name = replicationChannelName("userA");
    const transport = replicationTransport(name, "host");
    const scoped = scopedHostChannel(name, "host", transport.channel);
    const row = session("held", { title: "Initial session" });
    const unrelated = { _id: "unrelated", title: "Unrelated task" };
    const docRows = Object.fromEntries(
      Array.from({ length: 260 }, (_, i) => {
        const doc = { _id: `doc-${i}`, title: "Initial doc" };
        return [doc._id, doc];
      }),
    );
    let state = {
      sessions: { held: row },
      tasks: { unrelated },
      docs: docRows,
    };
    const host = replicationHostFor("host", scoped.channel, () => state);
    const joined = Promise.withResolvers<void>();
    const unsubscribe = useInboxStore.subscribe((next) => {
      if (next.syncRole === "follower") joined.resolve();
    });
    const stop = startSyncReplication({
      eligible: false,
      principalId: "userA",
      keys: ["sessions"],
    });
    const scopedFrames = () =>
      hub.posted
        .filter((item) => item.name.startsWith(`${name}:scope:`))
        .map((item) => item.data as ReplicationMessage);
    const scopedKeys = () =>
      scopedFrames().flatMap((frame) =>
        frame.type === "snapshotChunk" || frame.type === "update"
          ? frame.updates.map(({ key }) => key)
          : [],
      );
    try {
      await joined.promise;
      expect(useInboxStore.getState().sessions.held?.title).toBe(
        "Initial session",
      );
      expect(scopedKeys()).toEqual(["sessions"]);
      expect(hub.opened.filter((channel) => channel === name)).toHaveLength(1);
      const growth = expandWindowReplication(["sessions", "docs"]);
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      expect(
        scopedFrames().some(
          (frame) =>
            frame.type === "snapshotChunk" &&
            !frame.done &&
            frame.updates.some(({ key }) => key === "docs"),
        ),
      ).toBe(true);
      const changed = { ...row, title: "Changed during join" };
      const newerDoc = { ...docRows["doc-259"], title: "Newer doc" };
      state = {
        sessions: { held: changed },
        docs: { ...docRows, "doc-259": newerDoc },
        tasks: { unrelated: { ...unrelated, title: "Unrelated update" } },
      };
      host.tee(
        [
          { op: "replace", path: ["sessions"], value: state.sessions },
          { op: "replace", path: ["docs"], value: state.docs },
          { op: "replace", path: ["tasks"], value: state.tasks },
        ],
        state,
      );
      expect(await growth).toBe(true);
      expect(useInboxStore.getState().docs["doc-259"]?.title).toBe("Newer doc");
      expect(useInboxStore.getState().sessions.held?.title).toBe(
        "Changed during join",
      );
      expect(useInboxStore.getState().tasks.unrelated).toBeUndefined();
      expect(
        scopedKeys().filter((key) => key !== "sessions" && key !== "docs"),
      ).toEqual([]);
      const growthSnapshots = scopedFrames().filter(
        (frame) =>
          frame.type === "snapshotChunk" && frame.to.includes(":growth:"),
      );
      expect(
        growthSnapshots.flatMap((frame) => frame.updates.map(({ key }) => key)),
      ).toEqual(["docs", "docs"]);
      const settled = Promise.withResolvers<void>();
      const off = useInboxStore.subscribe((next) => {
        if (next.docs["doc-259"]?.title === "After growth") settled.resolve();
      });
      const current = { ...newerDoc, title: "After growth" };
      state = { ...state, docs: { ...state.docs, "doc-259": current } };
      try {
        host.tee(
          [{ op: "replace", path: ["docs", "doc-259"], value: current }],
          state,
        );
        await settled.promise;
        const deliveries = hub.posted.filter(
          ({ name: address, data }) =>
            address.startsWith(`${name}:scope:`) &&
            (data as ReplicationMessage).type === "update" &&
            (data as { seq: number }).seq === host.seq(),
        );
        expect(deliveries).toHaveLength(1);
        expect(deliveries[0]?.name).not.toContain(":growth:");
      } finally {
        off();
      }
    } finally {
      unsubscribe();
      stop();
      host.stop();
      scoped.close();
      transport.close();
      useInboxStore.setState({ sessions: {}, docs: {}, tasks: {} });
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
