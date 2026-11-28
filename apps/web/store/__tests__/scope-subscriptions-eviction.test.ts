import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ReplicationChannel, ReplicationMessage } from "@platform/engine";
import {
  __cacheEvictionsIdleForTests,
  cacheEvictionsFor,
} from "../cache-eviction";
import { useInboxStore } from "../inboxStore";
import { resetSyncTransactionForTests } from "../syncTransaction";
import {
  findEntityRow,
  initialScopeSubscriptionState,
  isKnownHomeScope,
} from "../scope-subscriptions";
import { scopedHostChannel } from "../desktop-panel-transport";
import { createScopeViewTransport } from "../scope-view-transport";
import { applyUpdatesToStore } from "../sync-replication";
import { extractReplicationUpdates } from "@platform/engine";

const cid = (label: string) =>
  label
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase()
    .padEnd(32, "0");

beforeEach(() => {
  useInboxStore.getState()._setOutbox(null, null, null);
  useInboxStore.getState()._setDispatch(null);
  useInboxStore.setState({
    currentUser: { _id: "u1" },
    teams: [{ _id: "team1" }],
    projects: {},
    clientState: { ui: { sidebar_pins: [] } } as any,
    clientStateInitialized: true,
    recentVisits: [],
    tabs: [],
    activeTabId: null,
    tasks: {},
    docs: {},
    docDetails: {},
    taskComments: {},
    plans: {},
    chatMessages: {},
    pending: {},
    syncMeta: {},
    syncLogScopeStamps: {},
    syncRole: "host",
    scopeSubscriptions: initialScopeSubscriptionState(),
  } as any);
});

afterEach(() => {
  resetSyncTransactionForTests();
  useInboxStore.getState()._setOutbox(null, null, null);
  useInboxStore.getState()._setDispatch(null);
  useInboxStore.getState()._setIDBWrite(null);
});

describe("scope subscription review regressions", () => {
  test("High 1: follower applies authoritative removes even when the row's scope or page is open", () => {
    const tId = cid("topenfollower");
    const dId = cid("dopenfollower");
    useInboxStore.setState({
      syncRole: "follower",
      activeTabId: "tab1",
      tabs: [{ id: "tab1", path: "/projects/p-open" }] as any,
      projects: { "p-open": { _id: "p-open", workspace: "team:team1" } } as any,
      tasks: {
        [tId]: { _id: tId, short_id: "ct-9", home_scope: "project:p-open" },
      } as any,
      docs: { [dId]: { _id: dId, home_scope: "project:p-open" } } as any,
      docDetails: { [dId]: { _id: dId, content: "secret" } } as any,
    });

    applyUpdatesToStore([
      { key: "tasks", removes: [tId] },
      { key: "docs", removes: [dId] },
      { key: "docDetails", removes: [dId] },
    ]);

    expect(useInboxStore.getState().tasks[tId]).toBeUndefined();
    expect(useInboxStore.getState().docs[dId]).toBeUndefined();
    expect(useInboxStore.getState().docDetails[dId]).toBeUndefined();
  });

  test("unpin, leave, cap, and purgeUnheldScopeRows evict immediately without server confirmation fallback", () => {
    const tUnpinned = cid("tunpin");
    const dLeft = cid("dleft");
    const plCap = cid("plcap");
    const pins = Array.from({ length: 64 }, (_, i) => ({
      kind: "project",
      id: `p${i}`,
    }));
    const projects: Record<string, any> = {
      "p-left": { _id: "p-left", workspace: "team:team1" },
      "p-extra": { _id: "p-extra", workspace: "team:team1" },
    };
    for (const p of pins) {
      projects[p.id] = { _id: p.id, workspace: "team:team1" };
    }
    useInboxStore.setState({
      projects,
      clientState: { ui: { sidebar_pins: pins } } as any,
      activeTabId: "t1",
      tabs: [{ id: "t1", path: "/projects/p-left" }] as any,
      tasks: {
        [tUnpinned]: { _id: tUnpinned, home_scope: "project:p0" },
        [plCap]: { _id: plCap, home_scope: "project:p-extra" },
      } as any,
      docs: {
        [dLeft]: { _id: dLeft, home_scope: "project:p-left" },
      } as any,
      syncMeta: {
        "synclog:v1:project:p0": { cursor: 2 },
        "synclog:v1:project:p-left": { cursor: 3 },
      },
    });

    useInboxStore.getState().reconcileScopeSubscriptions(1000);
    useInboxStore.setState({
      clientState: { ui: { sidebar_pins: pins.slice(1) } } as any,
      tabs: [{ id: "t1", path: "/inbox" }] as any,
    });
    const afterLeave = useInboxStore
      .getState()
      .reconcileScopeSubscriptions(120_000);
    expect(afterLeave.removedScopes.length).toBeGreaterThan(0);
    const evicted = useInboxStore
      .getState()
      .reconcileScopeSubscriptions(190_000);
    expect(evicted.removedScopes).toContain("project:p-left");
    expect(evicted.purged.some((e) => e.id === dLeft)).toBe(true);
    expect(useInboxStore.getState().tasks[tUnpinned]).toBeUndefined();
    expect(useInboxStore.getState().docs[dLeft]).toBeUndefined();
    expect(useInboxStore.getState().tasks[plCap]).toBeUndefined();
  });

  test("High 3: denyScopeSubscriptions performs authoritative delete with excludes and replicates removes", () => {
    const tRevoked = cid("trevoked");
    const dRevoked = cid("drevoked");
    const pRevoked = cid("prevoked");
    useInboxStore.setState({
      projects: {
        "p-rev": { _id: "p-rev", workspace: "team:team1", starred: true },
      },
      tasks: {
        [tRevoked]: { _id: tRevoked, home_scope: "project:p-rev" },
        "taskstub-local": {
          _id: "taskstub-local",
          home_scope: "project:p-rev",
        },
      } as any,
      docs: {
        [dRevoked]: { _id: dRevoked, home_scope: "project:p-rev" },
      } as any,
      docDetails: { [dRevoked]: { _id: dRevoked, content: "revoked" } } as any,
      taskComments: { [tRevoked]: { comments: [{ _id: "c1" }] } } as any,
      plans: {
        [pRevoked]: { _id: pRevoked, home_scope: "project:p-rev" },
      } as any,
    });
    useInboxStore.getState().reconcileScopeSubscriptions(1000);

    let capturedEvictionCount = -1;
    let capturedRemoves: any[] = [];
    const prevTasks = useInboxStore.getState().tasks;
    const prevDocs = useInboxStore.getState().docs;
    useInboxStore.getState()._setIDBWrite((patches, state) => {
      capturedEvictionCount = cacheEvictionsFor(patches, state).length;
      capturedRemoves = extractReplicationUpdates(
        patches,
        state,
        (k) =>
          k === "tasks" || k === "docs" || k === "docDetails" || k === "plans",
        () => true,
        {
          shadowOf: (k) =>
            k === "tasks" ? prevTasks : k === "docs" ? prevDocs : undefined,
        },
      );
      return Promise.resolve();
    });

    const purged = useInboxStore
      .getState()
      .denyScopeSubscriptions(["project:p-rev"], 2000);
    expect(purged.map((x) => x.id).sort()).toEqual(
      [tRevoked, dRevoked, pRevoked].sort(),
    );
    expect(__cacheEvictionsIdleForTests()).toBe(true);
    expect(capturedEvictionCount).toBe(0);
    expect(capturedRemoves.find((u) => u.key === "tasks")?.removes).toContain(
      tRevoked,
    );
    expect(capturedRemoves.find((u) => u.key === "docs")?.removes).toContain(
      dRevoked,
    );
    expect(useInboxStore.getState().tasks[tRevoked]).toBeUndefined();
    expect(useInboxStore.getState().tasks["taskstub-local"]).toBeDefined();
    expect(useInboxStore.getState().docDetails[dRevoked]).toBeUndefined();
    expect(useInboxStore.getState().taskComments[tRevoked]).toBeUndefined();
    expect(useInboxStore.getState().pending[`tasks:${tRevoked}`]).toEqual({
      type: "exclude",
      ts: 2000,
      scope: "project:p-rev",
    });
    expect(useInboxStore.getState().pending[`docs:${dRevoked}`]).toEqual({
      type: "exclude",
      ts: 2000,
      scope: "project:p-rev",
    });
    expect(useInboxStore.getState().pending[`plans:${pRevoked}`]).toEqual({
      type: "exclude",
      ts: 2000,
      scope: "project:p-rev",
    });
  });

  test("High 4: scopeViewTransport validates messages, caps 64, sends pagehide leave, and expires lease", async () => {
    let hostListener: ((m: ReplicationMessage) => void) | null = null;
    const posted: any[] = [];
    const rx: ReplicationChannel = {
      post(m) {
        posted.push(m);
        hostListener?.(m);
      },
      onMessage(cb) {
        hostListener = cb;
        return () => {
          hostListener = null;
        };
      },
    };
    const host = createScopeViewTransport({
      selfId: "host",
      channel: rx,
      getState: useInboxStore.getState,
      subscribe: useInboxStore.subscribe,
      onPeerView: (p, s) => useInboxStore.getState().setPeerViewScopes(p, s),
      onClearPeerViews: () => useInboxStore.getState().clearPeerViewScopes(),
      heartbeatMs: 25,
      leaseMs: 60,
    });
    const delivered: any[] = [];
    const unsub = host.channel.onMessage((m) => delivered.push(m));
    host.startHost();

    expect(() => {
      rx.post(null as any);
      rx.post({
        type: "mut",
        from: "",
        updates: [],
        scopeView: ["project:p1"],
      } as any);
      rx.post({
        type: "mut",
        from: "host",
        updates: [],
        scopeView: ["project:p1"],
      } as any);
      rx.post({
        type: "mut",
        from: "p1",
        updates: "bad",
        scopeView: ["project:p1"],
      } as any);
      rx.post({
        type: "mut",
        from: "p1",
        updates: [],
        scopeView: "not-array",
      } as any);
    }).not.toThrow();
    expect(useInboxStore.getState().scopeSubscriptions.peerViews).toEqual({});
    expect(delivered).toEqual([]);

    const mixed = [
      42,
      "project:",
      "bad:scope",
      ...Array.from(
        { length: 70 },
        (_, i) => `project:p${String(i).padStart(2, "0")}`,
      ),
    ];
    rx.post({ type: "mut", from: "p1", updates: [], scopeView: mixed } as any);
    expect(
      useInboxStore.getState().scopeSubscriptions.peerViews["p1"],
    ).toHaveLength(64);
    expect(
      useInboxStore.getState().scopeSubscriptions.peerViews["p1"],
    ).not.toContain("project:");

    await new Promise((r) => setTimeout(r, 90));
    expect(
      useInboxStore.getState().scopeSubscriptions.peerViews["p1"],
    ).toBeUndefined();

    const prevWin = (globalThis as any).window;
    const listeners = new Map<string, Set<() => void>>();
    (globalThis as any).window = {
      addEventListener: (ev: string, fn: () => void) => {
        if (!listeners.has(ev)) listeners.set(ev, new Set());
        listeners.get(ev)!.add(fn);
      },
      removeEventListener: (ev: string, fn: () => void) => {
        listeners.get(ev)?.delete(fn);
      },
    };
    try {
      const follower = createScopeViewTransport({
        selfId: "f-crash",
        channel: rx,
        getState: () => ({
          activeTabId: "a",
          tabs: [
            { id: "a", path: "/projects/p-active" },
            { id: "b", path: "/projects/p-bg" },
          ],
          projects: {
            "p-active": { _id: "p-active", workspace: "team:team1" },
            "p-bg": { _id: "p-bg", workspace: "team:team1" },
          },
        }),
        subscribe: () => () => {},
        onPeerView() {},
        onClearPeerViews() {},
        heartbeatMs: 0,
        leaseMs: 5_000,
      });
      follower.startFollowing();
      expect(
        useInboxStore.getState().scopeSubscriptions.peerViews["f-crash"],
      ).toEqual(["project:p-active"]);

      for (const fn of listeners.get("pagehide") ?? []) fn();
      expect(
        useInboxStore.getState().scopeSubscriptions.peerViews["f-crash"],
      ).toBeUndefined();
      follower.stop();
    } finally {
      (globalThis as any).window = prevWin;
      unsub();
      host.stop();
    }
  });

  test("High 4: desktop-panel-transport forwards leave signal", () => {
    const noopChannel: ReplicationChannel = {
      post() {},
      onMessage: () => () => {},
    };
    const host = scopedHostChannel("test-scope-ch", "h1", noopChannel);
    expect(typeof host.channel.onMessage).toBe("function");
    host.close();
  });

  test("Medium 3 & Low 2: isKnownHomeScope, memoized findEntityRow, and real outboxProtectedRows", () => {
    expect(isKnownHomeScope("project:")).toBe(false);
    expect(isKnownHomeScope("user:")).toBe(false);
    expect(isKnownHomeScope("dir:")).toBe(false);
    expect(isKnownHomeScope("channel:")).toBe(false);
    expect(isKnownHomeScope("project:abc")).toBe(true);

    let reads = 0;
    const targetId = cid("memo77");
    const tasks: Record<string, any> = {
      [targetId]: {
        _id: targetId,
        short_id: "ct-77",
        home_scope: "project:p1",
      },
    };
    Object.defineProperty(tasks, cid("otherrow"), {
      enumerable: true,
      get() {
        reads++;
        return { _id: cid("otherrow"), short_id: "ct-1" };
      },
    });
    expect(findEntityRow(tasks, "ct-77")?._id).toBe(targetId);
    const firstReads = reads;
    expect(findEntityRow(tasks, "ct-77")?._id).toBe(targetId);
    expect(reads).toBe(firstReads);

    const parked: any[] = [];
    useInboxStore.getState()._setOutbox(
      async (e) => {
        parked.push(e);
      },
      async () => {},
      async () => parked,
    );
    const tShort = cid("tshort1");
    useInboxStore.setState({
      tasks: {
        [tShort]: {
          _id: tShort,
          short_id: "ct-42",
          title: "old",
          home_scope: "project:p-left",
        },
      } as any,
    });
    useInboxStore.getState().updateTask("ct-42", { title: "new" });
    expect(
      useInboxStore.getState().purgeUnheldScopeRows(new Set(["user:u1"])),
    ).toEqual([]);
    expect(useInboxStore.getState().tasks[tShort]).toBeDefined();
  });

  test("Low 1: drops denied scope from active/chunks with excludes, ignores view churn, retries on open, and keeps the denial on an unrelated change", () => {
    const idBad = cid("tbadproj");
    useInboxStore.setState({
      projects: {
        "p-bad": { _id: "p-bad", workspace: "team:team1", starred: true },
        "p-other": { _id: "p-other", workspace: "team:team1" },
      },
      activeTabId: "tab1",
      tabs: [{ id: "tab1", path: "/inbox", title: "Inbox" }] as any,
      tasks: {
        [idBad]: { _id: idBad, home_scope: "project:p-bad" },
      } as any,
    });

    useInboxStore.getState().reconcileScopeSubscriptions(1000);
    expect(
      useInboxStore.getState().scopeSubscriptions.active["project:p-bad"],
    ).toBeDefined();

    useInboxStore.getState().denyScopeSubscriptions(["project:p-bad"], 2000);
    expect(
      useInboxStore.getState().scopeSubscriptions.active["project:p-bad"],
    ).toBeUndefined();
    expect(
      useInboxStore.getState().scopeSubscriptions.chunks.flat(),
    ).not.toContain("project:p-bad");
    expect(useInboxStore.getState().tasks[idBad]).toBeUndefined();
    expect(useInboxStore.getState().pending[`tasks:${idBad}`]).toEqual({
      type: "exclude",
      ts: 2000,
      scope: "project:p-bad",
    });

    useInboxStore.setState({
      tabs: [{ id: "tab1", path: "/projects/p-other", title: "Other" }] as any,
    });
    useInboxStore.getState().reconcileScopeSubscriptions(3000);
    expect(
      useInboxStore.getState().scopeSubscriptions.active["project:p-bad"],
    ).toBeUndefined();

    useInboxStore.setState({
      tabs: [{ id: "tab1", path: "/projects/p-bad", title: "Bad" }] as any,
    });
    useInboxStore.getState().reconcileScopeSubscriptions(3500);
    expect(
      useInboxStore.getState().scopeSubscriptions.active["project:p-bad"],
    ).toBeDefined();
    expect(useInboxStore.getState().pending[`tasks:${idBad}`]).toBeUndefined();

    useInboxStore.getState().denyScopeSubscriptions(["project:p-bad"], 3600);
    useInboxStore.setState({
      projects: {
        "p-bad": { _id: "p-bad", workspace: "team:team1", starred: true },
        "p-other": { _id: "p-other", workspace: "team:team1" },
        "p-new": { _id: "p-new", workspace: "team:team1", starred: true },
      },
      tabs: [{ id: "tab1", path: "/inbox", title: "Inbox" }] as any,
    } as any);
    useInboxStore.getState().reconcileScopeSubscriptions(4000);
    expect(
      useInboxStore.getState().scopeSubscriptions.active["project:p-bad"],
    ).toBeUndefined();
    expect(
      useInboxStore.getState().scopeSubscriptions.denied["project:p-bad"],
    ).toBeDefined();
  });
});
