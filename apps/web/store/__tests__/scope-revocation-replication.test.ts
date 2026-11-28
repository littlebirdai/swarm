import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useInboxStore } from "../inboxStore";
import { resetSyncTransactionForTests } from "../syncTransaction";
import { initialScopeSubscriptionState } from "../scope-subscriptions";
import {
  applyUpdatesToStore,
  replicationFollowerFor,
  replicationHostFor,
} from "../sync-replication";
import { replicationTransport } from "../storage-transport";
import {
  scopedFollowerChannel,
  scopedHostChannel,
} from "../desktop-panel-transport";
import { pinDetailRows, resetDetailPins } from "../../lib/detail-rows";
import { DESKTOP_WINDOW_KEYS } from "../desktop-panel-keys";
import { deleteAllowed } from "../idb-collection-diff";
import { createScopeViewTransport } from "../scope-view-transport";
import {
  SCOPE_DENY_MAX,
  SCOPE_DENY_TTL_MS,
  candidatesDigest,
  extractScopeCandidates,
  reconcileScopeSubscriptions,
} from "../scope-subscriptions";
import { dropRevokedRowMap } from "../scope-subscription-candidates";
import { takeHostRole } from "../host-role";

const cid = (label: string) =>
  label
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase()
    .padEnd(32, "0");

const T = "team1";
const T2 = "team2";
const dOpen = cid("dopenonfollower");
const tTeam = cid("tteamrow");
const tOther = cid("totherteam");
const tMine = cid("tmine");

async function until(check: () => boolean, label: string, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function seedFollower() {
  useInboxStore.setState({
    currentUser: undefined,
    syncRole: "follower",
    pending: {},
    scopeSubscriptions: initialScopeSubscriptionState(),
    scopeRevocations: {},
    docs: {},
    docDetails: {
      [dOpen]: { _id: dOpen, workspace: `team:${T}`, content: "secret" },
    },
    tasks: {
      [tTeam]: { _id: tTeam, workspace: `team:${T}` },
      [tOther]: { _id: tOther, workspace: `team:${T2}` },
      [tMine]: { _id: tMine, workspace: "user:u1" },
    },
    taskComments: {},
  } as any);
}

let cleanups: Array<() => void> = [];
let releasePin: () => void = () => {};

beforeEach(() => {
  resetDetailPins();
  seedFollower();
  releasePin = pinDetailRows("docDetails", [dOpen]);
});

afterEach(() => {
  for (const fn of cleanups.reverse()) fn();
  cleanups = [];
  releasePin();
  resetDetailPins();
  resetSyncTransactionForTests();
});

function mainHost(state: Record<string, any>) {
  const name = `test-revoke-${crypto.randomUUID()}`;
  const hostTransport = replicationTransport(name, "host");
  const host = replicationHostFor("host", hostTransport.channel, () => state);
  cleanups.push(() => {
    host.stop();
    hostTransport.close();
  });
  return { name, host };
}

function joinFollower(name: string) {
  const transport = replicationTransport(name, "follower");
  let synced = false;
  const follower = replicationFollowerFor(
    "follower",
    transport.channel,
    (s) => {
      synced = s;
    },
  );
  cleanups.push(() => {
    follower.stop();
    transport.close();
  });
  return { synced: () => synced };
}

describe("scope revocations as replicated state", () => {
  test("a follower that joins after the revocation removes the revoked rows, pins included", async () => {
    const { name } = mainHost({ scopeRevocations: { [`dir:${T}`]: 5 } });
    const follower = joinFollower(name);
    await until(follower.synced, "follower synced");
    await until(
      () => useInboxStore.getState().docDetails[dOpen] === undefined,
      "orphan detail removed",
    );
    const s = useInboxStore.getState() as any;
    expect(s.tasks[tTeam]).toBeUndefined();
    expect(s.tasks[tOther]).toBeDefined();
    expect(s.tasks[tMine]).toBeDefined();
    expect(s.pending[`tasks:${tTeam}`]).toMatchObject({
      type: "exclude",
      scope: `dir:${T}`,
    });
  });

  test("a re-grant lifts the excludes the revocation planted on a follower", async () => {
    const state: Record<string, any> = {
      scopeRevocations: { [`dir:${T}`]: 5 },
    };
    const { name, host } = mainHost(state);
    const follower = joinFollower(name);
    await until(follower.synced, "follower synced");
    await until(
      () => useInboxStore.getState().tasks[tTeam] === undefined,
      "team row removed",
    );
    state.scopeRevocations = {};
    host.publish([{ key: "scopeRevocations", value: {}, hasValue: true }]);
    await until(
      () => useInboxStore.getState().pending[`tasks:${tTeam}`] === undefined,
      "exclude lifted",
    );
    useInboxStore
      .getState()
      .syncTable(
        "tasks",
        [{ _id: tTeam, workspace: `team:${T}`, title: "back" }],
        { isDelta: true },
      );
    expect(useInboxStore.getState().tasks[tTeam]?.title).toBe("back");
  });

  test("a peer that is not the host cannot remove rows", async () => {
    const state: Record<string, any> = { scopeRevocations: {} };
    const { name, host } = mainHost(state);
    const follower = joinFollower(name);
    await until(follower.synced, "follower synced");
    const rogue = replicationTransport(name, "rogue");
    cleanups.push(() => rogue.close());
    rogue.channel.post({
      type: "update",
      hostId: "rogue",
      seq: 1,
      origin: "rogue",
      updates: [
        {
          key: "scopeRevocations",
          value: { [`dir:${T2}`]: 9 },
          hasValue: true,
        },
      ],
    } as any);
    state.scopeRevocations = { [`dir:${T}`]: 7 };
    host.publish([
      { key: "scopeRevocations", value: { [`dir:${T}`]: 7 }, hasValue: true },
    ]);
    await until(
      () => useInboxStore.getState().tasks[tTeam] === undefined,
      "host revocation applied",
    );
    expect(useInboxStore.getState().tasks[tOther]).toBeDefined();
    expect(useInboxStore.getState().scopeRevocations).toEqual({
      [`dir:${T}`]: 7,
    });
  });

  test("a desktop panel that joins after the revocation removes the revoked rows", async () => {
    const name = `test-revoke-panel-${crypto.randomUUID()}`;
    const legacy = replicationTransport(name, "host");
    const modern = scopedHostChannel(name, "host", legacy.channel);
    modern.activate();
    const host = replicationHostFor("host", modern.channel, () => ({
      scopeRevocations: { [`dir:${T}`]: 5 },
    }));
    for (const panelKeys of Object.values(DESKTOP_WINDOW_KEYS))
      expect(panelKeys).toContain("scopeRevocations");
    const keys = [...DESKTOP_WINDOW_KEYS["call-panel"]];
    const scope = scopedFollowerChannel(name, "panel", keys, () =>
      replicationTransport(name, "panel"),
    );
    let synced = false;
    const follower = replicationFollowerFor(
      "panel",
      scope.channel,
      (s) => {
        synced = s;
      },
      undefined,
      keys,
    );
    cleanups.push(() => {
      follower.stop();
      scope.close();
      host.stop();
      modern.close();
      legacy.close();
    });
    await until(() => synced, "panel synced");
    await until(
      () => useInboxStore.getState().docDetails[dOpen] === undefined,
      "panel detail removed",
    );
    expect(useInboxStore.getState().tasks[tTeam]).toBeUndefined();
  });

  test("replicated state never revokes a user scope", () => {
    useInboxStore
      .getState()
      .applyReplicatedScopeRevocations({ "user:u1": 3, [`dir:${T2}`]: 4 });
    const s = useInboxStore.getState() as any;
    expect(s.tasks[tMine]).toBeDefined();
    expect(s.tasks[tOther]).toBeUndefined();
    expect(s.scopeRevocations).toEqual({ [`dir:${T2}`]: 4 });
  });

  test("the host publishes its denied scopes and drops them on a re-grant", () => {
    useInboxStore.setState({
      currentUser: { _id: "u1" },
      syncRole: "host",
      teams: [{ _id: T }],
    } as any);
    useInboxStore.getState().revokeTeamScope(T, 42);
    expect(useInboxStore.getState().scopeRevocations).toEqual({
      [`dir:${T}`]: 42,
    });
    useInboxStore.getState().clearDeniedScopeSubscriptions([`dir:${T}`]);
    expect(useInboxStore.getState().scopeRevocations).toEqual({});
  });

  test("a mut from a peer cannot revoke on the host or replace the projection", async () => {
    useInboxStore.setState({ syncRole: "host" } as any);
    const name = `test-revoke-mut-${crypto.randomUUID()}`;
    const hostTransport = replicationTransport(name, "host");
    const host = replicationHostFor("host", hostTransport.channel, () =>
      useInboxStore.getState(),
    );
    const rogue = replicationTransport(name, "rogue");
    cleanups.push(() => {
      host.stop();
      hostTransport.close();
      rogue.close();
    });
    const projectionBefore = (useInboxStore.getState() as any)
      .sessionsProjection;
    rogue.channel.post({
      type: "mut",
      from: "rogue",
      updates: [
        {
          key: "scopeRevocations",
          value: { [`dir:${T}`]: 9 },
          hasValue: true,
        },
        {
          key: "sessionsProjection",
          value: { epoch: 99, stamps: {} },
          hasValue: true,
        },
      ],
    } as any);
    await new Promise((r) => setTimeout(r, 50));
    const s = useInboxStore.getState() as any;
    expect(s.tasks[tTeam]).toBeDefined();
    expect(s.scopeRevocations).toEqual({});
    expect(s.sessionsProjection).toBe(projectionBefore);
  });

  test("a revocation lets the doc body and the comment thread leave disk", () => {
    useInboxStore.setState({
      currentUser: { _id: "u1" },
      syncRole: "host",
      teams: [{ _id: T }],
      taskComments: { [tTeam]: { _id: tTeam, comments: [] } },
    } as any);
    useInboxStore.getState().revokeTeamScope(T, 10);
    const pending = useInboxStore.getState().pending as any;
    expect(deleteAllowed("docDetails", dOpen, pending)).toBe(true);
    expect(deleteAllowed("taskComments", tTeam, pending)).toBe(true);
  });

  test("a promoted window keeps the revocations and lifts them on a re-grant", () => {
    useInboxStore
      .getState()
      .applyReplicatedScopeRevocations({ [`dir:${T}`]: 5 });
    expect(useInboxStore.getState().tasks[tTeam]).toBeUndefined();
    useInboxStore.setState({
      currentUser: { _id: "u1" },
      syncRole: "host",
      teams: [{ _id: T }],
    } as any);
    useInboxStore.getState().adoptScopeRevocations(1000);
    let s = useInboxStore.getState() as any;
    expect(s.scopeSubscriptions.denied[`dir:${T}`]).toBeDefined();
    expect(s.scopeRevocations[`dir:${T}`]).toBeGreaterThan(5);
    expect(s.pending[`tasks:${tTeam}`]).toMatchObject({ type: "exclude" });
    useInboxStore.getState().clearDeniedScopeSubscriptions([`dir:${T}`]);
    s = useInboxStore.getState() as any;
    expect(s.scopeRevocations).toEqual({});
    expect(s.pending[`tasks:${tTeam}`]).toBeUndefined();
  });

  test("a window with stale revocations and no denials clears them", () => {
    useInboxStore
      .getState()
      .applyReplicatedScopeRevocations({ [`dir:${T}`]: 5 });
    useInboxStore.setState({ syncRole: "host" } as any);
    useInboxStore.getState().clearDeniedScopeSubscriptions();
    expect(useInboxStore.getState().scopeRevocations).toEqual({});
    expect(
      (useInboxStore.getState().pending as any)[`tasks:${tTeam}`],
    ).toBeUndefined();
    useInboxStore.setState({
      currentUser: { _id: "u1" },
      teams: [{ _id: T }],
    } as any);
    useInboxStore.getState().reconcileScopeSubscriptions(2000);
    useInboxStore
      .getState()
      .applyReplicatedScopeRevocations({ [`dir:${T}`]: 6 });
    expect(useInboxStore.getState().scopeRevocations).toEqual({
      [`dir:${T}`]: 6,
    });
    useInboxStore.getState().reconcileScopeSubscriptions(2000);
    expect(useInboxStore.getState().scopeRevocations).toEqual({});
  });

  test("replicated times must be finite and newer", () => {
    const apply = useInboxStore.getState().applyReplicatedScopeRevocations;
    apply({ [`dir:${T}`]: 10 });
    useInboxStore.setState({
      pending: {},
      tasks: {
        ...useInboxStore.getState().tasks,
        [tTeam]: { _id: tTeam, workspace: `team:${T}` },
      },
    } as any);
    apply({ [`dir:${T}`]: 5 });
    expect(useInboxStore.getState().tasks[tTeam]).toBeDefined();
    expect(useInboxStore.getState().scopeRevocations).toEqual({
      [`dir:${T}`]: 10,
    });
    apply({ [`dir:${T}`]: 10, [`dir:${T2}`]: Number.NaN });
    expect(useInboxStore.getState().tasks[tOther]).toBeDefined();
  });

  test("host deny times only move forward, and the deny map is pruned and capped", () => {
    useInboxStore.setState({
      currentUser: { _id: "u1" },
      syncRole: "host",
      teams: [{ _id: T }],
    } as any);
    useInboxStore.getState().revokeTeamScope(T, 100);
    useInboxStore.getState().revokeTeamScope(T, 50);
    expect(useInboxStore.getState().scopeRevocations[`dir:${T}`]).toBe(101);
    const many = Array.from(
      { length: SCOPE_DENY_MAX + 20 },
      (_, i) => `project:p${i}`,
    );
    useInboxStore.getState().denyScopeSubscriptions(many, 200);
    expect(
      Object.keys(useInboxStore.getState().scopeSubscriptions.denied).length,
    ).toBeLessThanOrEqual(SCOPE_DENY_MAX);
    useInboxStore
      .getState()
      .denyScopeSubscriptions(["project:late"], 200 + SCOPE_DENY_TTL_MS);
    const denied = useInboxStore.getState().scopeSubscriptions.denied;
    expect(Object.keys(denied)).toEqual(["project:late"]);
    expect(Object.keys(useInboxStore.getState().scopeRevocations)).toEqual([
      "project:late",
    ]);
  });

  test("a follower revocation drops the team feed cache", () => {
    useInboxStore.setState({
      feedConversations: {
        [`${T}|`]: [{ _id: "a", user_id: "u9", updated_at: 1 }],
        [`${T2}|`]: [{ _id: "b", user_id: "u9", updated_at: 1 }],
      },
      feedHasMore: { [`${T}|`]: true, [`${T2}|`]: true },
      feedCursors: { [`${T}|`]: "5", [`${T2}|`]: "7" },
    } as any);
    useInboxStore
      .getState()
      .applyReplicatedScopeRevocations({ [`dir:${T}`]: 5 });
    const s = useInboxStore.getState() as any;
    expect(Object.keys(s.feedConversations)).toEqual([`${T2}|`]);
    expect(Object.keys(s.feedHasMore)).toEqual([`${T2}|`]);
    expect(Object.keys(s.feedCursors)).toEqual([`${T2}|`]);
  });

  test("stopping the scope view transport removes its subscription, timer and listener", async () => {
    const added: string[] = [];
    const removed: string[] = [];
    const hadWindow = "window" in globalThis;
    const previous = (globalThis as any).window;
    (globalThis as any).window = {
      addEventListener: (type: string) => added.push(type),
      removeEventListener: (type: string) => removed.push(type),
    };
    let unsubscribed = 0;
    let posts = 0;
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;
    const started: unknown[] = [];
    const cleared: unknown[] = [];
    (globalThis as any).setInterval = (fn: () => void, ms: number) => {
      const id = realSetInterval(fn, ms);
      started.push(id);
      return id;
    };
    (globalThis as any).clearInterval = (id: any) => {
      cleared.push(id);
      realClearInterval(id);
    };
    try {
      const transport = createScopeViewTransport({
        selfId: "follower",
        channel: {
          post: () => {
            posts++;
          },
          onMessage: () => () => {},
        } as any,
        getState: () => ({}) as any,
        subscribe: () => () => {
          unsubscribed++;
        },
        onPeerView: () => {},
        onClearPeerViews: () => {},
        heartbeatMs: 5,
      });
      transport.startFollowing();
      transport.stop();
      const after = posts;
      await new Promise((r) => setTimeout(r, 30));
      expect(posts).toBe(after);
      expect(unsubscribed).toBe(1);
      expect(added).toEqual(["pagehide"]);
      expect(removed).toEqual(["pagehide"]);
      expect(started.length).toBe(1);
      expect(cleared).toContain(started[0]);
    } finally {
      (globalThis as any).setInterval = realSetInterval;
      (globalThis as any).clearInterval = realClearInterval;
      if (hadWindow) (globalThis as any).window = previous;
      else delete (globalThis as any).window;
    }
  });

  test("a peer mut cannot remove or patch an ephemeral key on the host", () => {
    useInboxStore.setState({
      syncRole: "host",
      scopeRevocations: { [`dir:${T}`]: 5 },
    } as any);
    const projection = (useInboxStore.getState() as any).sessionsProjection;
    applyUpdatesToStore(
      [
        { key: "scopeRevocations", removes: [`dir:${T}`] },
        {
          key: "sessionsProjection",
          fields: { epoch: { value: 99 } },
        } as any,
      ],
      { optimistic: true },
    );
    const s = useInboxStore.getState() as any;
    expect(s.scopeRevocations).toEqual({ [`dir:${T}`]: 5 });
    expect(s.sessionsProjection).toBe(projection);
  });

  describe("rows that arrive after the revocation", () => {
    beforeEach(() => {
      useInboxStore
        .getState()
        .applyReplicatedScopeRevocations({ [`dir:${T}`]: 5 });
      useInboxStore.setState({ pending: {} } as any);
    });

    test("a new host's disk hydration of a doc body is dropped", () => {
      const late = cid("dlatedisk");
      useInboxStore
        .getState()
        .syncTable(
          "docDetails",
          [{ _id: late, workspace: `team:${T}`, content: "secret" }],
          { isDelta: true },
        );
      expect(useInboxStore.getState().docDetails[late]).toBeUndefined();
      const fromDisk = {
        [late]: { _id: late, workspace: `team:${T}` },
        [tMine]: { _id: tMine, workspace: "user:u1" },
      };
      expect(
        Object.keys(
          dropRevokedRowMap(useInboxStore.getState(), "tasks", fromDisk),
        ),
      ).toEqual([tMine]);
    });

    test("a stale follower mut relayed by the new host is dropped", () => {
      const stale = cid("tstalemut");
      applyUpdatesToStore(
        [
          {
            key: "tasks",
            upserts: [{ _id: stale, workspace: `team:${T}`, title: "stale" }],
          },
        ],
        { optimistic: true },
      );
      expect(useInboxStore.getState().tasks[stale]).toBeUndefined();
    });

    test("a cold per-view query that lands after the revocation is dropped", () => {
      const cold = cid("dcoldview");
      useInboxStore.getState().syncRecord("docDetails", cold, {
        _id: cold,
        workspace: `team:${T}`,
        content: "secret",
      });
      expect(useInboxStore.getState().docDetails[cold]).toBeUndefined();
      useInboxStore.getState().syncRecord("tasks", tMine, {
        _id: tMine,
        workspace: "user:u1",
        title: "still mine",
      });
      expect(useInboxStore.getState().tasks[tMine]?.title).toBe("still mine");
    });
  });

  test("the follower cap keeps team scopes first and never lifts on eviction", () => {
    const value: Record<string, number> = { [`dir:${T}`]: 1 };
    for (let i = 0; i < SCOPE_DENY_MAX + 10; i++)
      value[`project:p${i}`] = 100 + i;
    useInboxStore.getState().applyReplicatedScopeRevocations(value);
    let s = useInboxStore.getState() as any;
    expect(Object.keys(s.scopeRevocations).length).toBe(SCOPE_DENY_MAX);
    expect(s.scopeRevocations[`dir:${T}`]).toBe(1);
    expect(s.tasks[tTeam]).toBeUndefined();
    expect(s.pending[`tasks:${tTeam}`]).toMatchObject({ type: "exclude" });
    const crowded: Record<string, number> = {};
    for (let i = 0; i < SCOPE_DENY_MAX + 10; i++)
      crowded[`dir:d${i}`] = 500 + i;
    crowded[`dir:${T}`] = 1;
    useInboxStore.getState().applyReplicatedScopeRevocations(crowded);
    s = useInboxStore.getState() as any;
    expect(s.scopeRevocations[`dir:${T}`]).toBeUndefined();
    expect(s.pending[`tasks:${tTeam}`]).toMatchObject({ type: "exclude" });
  });

  test("the host cap keeps team scopes, revokes only kept scopes and never lifts on eviction", () => {
    useInboxStore.setState({
      currentUser: { _id: "u1" },
      syncRole: "host",
      teams: [{ _id: T }],
    } as any);
    useInboxStore.getState().revokeTeamScope(T, 100);
    const many = Array.from(
      { length: SCOPE_DENY_MAX + 5 },
      (_, i) => `project:p${i}`,
    );
    const projectRows: Record<string, any> = {};
    many.forEach((scope, i) => {
      const id = cid(`tproj${i}`);
      projectRows[id] = {
        _id: id,
        workspace: `team:${T2}`,
        project_id: scope.slice(8),
      };
    });
    useInboxStore.setState({
      tasks: { ...useInboxStore.getState().tasks, ...projectRows },
    } as any);
    useInboxStore.getState().denyScopeSubscriptions(many, 200);
    const s = useInboxStore.getState() as any;
    for (const [id, row] of Object.entries(projectRows)) {
      const kept = `project:${row.project_id}` in s.scopeRevocations;
      expect(s.tasks[id] === undefined).toBe(kept);
      expect(s.pending[`tasks:${id}`] !== undefined).toBe(kept);
    }
    expect(s.scopeSubscriptions.denied[`dir:${T}`]).toBeDefined();
    expect(Object.keys(s.scopeSubscriptions.denied).length).toBe(
      SCOPE_DENY_MAX,
    );
    expect(s.pending[`tasks:${tTeam}`]).toMatchObject({ type: "exclude" });
    const evicted = many.filter((scope) => !(scope in s.scopeRevocations));
    expect(evicted.length).toBe(6);
  });

  test("clearing a scope that is not denied still publishes", () => {
    useInboxStore
      .getState()
      .applyReplicatedScopeRevocations({ [`dir:${T}`]: 5 });
    useInboxStore.setState({
      syncRole: "host",
      scopeSubscriptions: {
        ...initialScopeSubscriptionState(),
        denied: { [`dir:${T2}`]: { digest: "x", at: Date.now() } },
      },
    } as any);
    useInboxStore.getState().clearDeniedScopeSubscriptions(["project:none"]);
    expect(Object.keys(useInboxStore.getState().scopeRevocations)).toEqual([
      `dir:${T2}`,
    ]);
    expect(
      (useInboxStore.getState().pending as any)[`tasks:${tTeam}`],
    ).toBeUndefined();
  });

  test("an unrelated candidate change keeps a denial, and the deny limit is scheduled", () => {
    const state: any = {
      currentUser: { _id: "u1" },
      teams: [{ _id: T }],
      projects: {
        pa: { _id: "pa", workspace: `team:${T}`, starred: true },
      },
    };
    const first = extractScopeCandidates(state, 1000);
    const prev = {
      ...initialScopeSubscriptionState(),
      principalId: "u1",
      denied: {
        "project:pa": { digest: candidatesDigest(first), at: 1000 },
      },
    };
    state.projects.pb = { _id: "pb", workspace: `team:${T}`, starred: true };
    const changed = extractScopeCandidates(state, 2000);
    const out = reconcileScopeSubscriptions(prev, changed, 2000);
    expect(out.state.denied["project:pa"]).toBeDefined();
    expect(out.nextGraceExpiryAt).toBe(1000 + SCOPE_DENY_TTL_MS);
    delete state.projects.pa;
    const gone = reconcileScopeSubscriptions(
      out.state,
      extractScopeCandidates(state, 3000),
      3000,
    );
    expect(gone.state.denied["project:pa"]).toBeUndefined();
  });

  test("promotion installs the host writer, adopts, then sets the role, starts and reads disk", () => {
    useInboxStore
      .getState()
      .applyReplicatedScopeRevocations({ [`dir:${T}`]: 5 });
    useInboxStore.setState({
      currentUser: { _id: "u1" },
      teams: [{ _id: T }],
    } as any);
    const seen: string[] = [];
    const adopted = () =>
      !!(useInboxStore.getState() as any).scopeSubscriptions.denied[`dir:${T}`];
    takeHostRole({
      installWriter: () => seen.push(`writer:${adopted()}`),
      setRole: () => seen.push(`role:${adopted()}`),
      start: () => seen.push(`start:${adopted()}`),
      useDiskCache: () => seen.push(`disk:${adopted()}`),
    });
    expect(seen).toEqual([
      "writer:false",
      "role:true",
      "start:true",
      "disk:true",
    ]);
  });
});
