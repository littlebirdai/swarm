import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import { useInboxStore } from "../inboxStore";
import { resetSyncTransactionForTests } from "../syncTransaction";
import {
  extractScopeCandidates,
  initialScopeSubscriptionState,
} from "../scope-subscriptions";
import { applyUpdatesToStore } from "../sync-replication";
import { holdScopeViewTarget } from "../scope-view-targets";
import { createScopeViewTransport } from "../scope-view-transport";
import { pinDetailRows, resetDetailPins } from "../../lib/detail-rows";
import {
  catchUp,
  catchUpScope,
  scopeMetaKey,
} from "../../hooks/use-sync-change-feed";
import { scopeInputsSig } from "../../hooks/use-scope-subscriptions";

const cid = (label: string) =>
  label
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase()
    .padEnd(32, "0");

const P = cid("projectopen");
const T = "team1";

function heads(answer: (scopes: string[]) => any) {
  const ranges: any[] = [];
  return {
    ranges,
    query: async (fn: any, args: any) => {
      const name = getFunctionName(fn);
      if (name === "syncLog:getHeads") return answer(args.scopes ?? []);
      if (name === "syncLog:getRange") {
        ranges.push(args);
        return { actions: [], nextFrom: args.from, hasMore: false };
      }
      throw new Error(`unexpected query ${name}`);
    },
  };
}

beforeEach(() => {
  resetDetailPins();
  useInboxStore.getState()._setOutbox(null, null, null);
  useInboxStore.getState()._setDispatch(null);
  useInboxStore.setState({
    currentUser: { _id: "u1" },
    teams: [{ _id: T }],
    projects: { [P]: { _id: P, workspace: `team:${T}` } },
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
    syncLogLag: {},
    syncLogFloorEpoch: 0,
    crawlResets: {},
    syncRole: "host",
    scopeSubscriptions: initialScopeSubscriptionState(),
    scopeViewTargets: {},
  } as any);
});

afterEach(() => {
  resetDetailPins();
  resetSyncTransactionForTests();
});

describe("view targets set by a screen", () => {
  test("a project screen adds its scope and removes it on leave", () => {
    const s = useInboxStore.getState();
    s.setScopeViewTargets("screen-a", [{ kind: "project", id: P }]);
    expect(
      extractScopeCandidates(useInboxStore.getState(), 1000).view,
    ).toContain(`project:${P}`);
    const added = useInboxStore.getState().reconcileScopeSubscriptions(1000);
    expect(added.addedScopes).toContain(`project:${P}`);
    useInboxStore.getState().setScopeViewTargets("screen-a", []);
    expect(useInboxStore.getState().scopeViewTargets).toEqual({});
    expect(
      extractScopeCandidates(useInboxStore.getState(), 2000).view,
    ).not.toContain(`project:${P}`);
  });

  test("a task screen follows the task's home scope and the inputs signature moves", () => {
    const tId = cid("taskinproject");
    useInboxStore.setState({
      tasks: {
        [tId]: {
          _id: tId,
          short_id: "ct-7",
          workspace: `team:${T}`,
          project_id: P,
        },
      },
    } as any);
    const before = scopeInputsSig(useInboxStore.getState());
    useInboxStore
      .getState()
      .setScopeViewTargets("screen-t", [{ kind: "task", id: "ct-7" }]);
    expect(scopeInputsSig(useInboxStore.getState())).not.toBe(before);
    expect(extractScopeCandidates(useInboxStore.getState(), 1000).view).toEqual(
      [`project:${P}`],
    );
  });

  test("the owner map is capped", () => {
    for (let i = 0; i < 40; i++)
      useInboxStore
        .getState()
        .setScopeViewTargets(`screen-${i}`, [{ kind: "channel", id: `c${i}` }]);
    const owners = Object.keys(useInboxStore.getState().scopeViewTargets);
    expect(owners.length).toBe(16);
    expect(owners).toContain("screen-39");
    expect(owners).not.toContain("screen-0");
  });
});

describe("view target owners", () => {
  test("a repeated call promotes its owner so the cap drops an older one", () => {
    const set = useInboxStore.getState().setScopeViewTargets;
    set("bottom", [{ kind: "project", id: P }]);
    for (let i = 0; i < 15; i++)
      set(`pushed-${i}`, [{ kind: "channel", id: `c${i}` }]);
    set("bottom", [{ kind: "project", id: P }]);
    set("pushed-new", [{ kind: "channel", id: "cnew" }]);
    const owners = Object.keys(useInboxStore.getState().scopeViewTargets);
    expect(owners).toContain("bottom");
    expect(owners).not.toContain("pushed-0");
    expect(owners.length).toBe(16);
  });

  test("a held target lasts until its release", () => {
    const release = holdScopeViewTarget("focused", "project", P);
    expect(useInboxStore.getState().scopeViewTargets.focused).toEqual([
      { kind: "project", id: P },
    ]);
    release();
    expect(useInboxStore.getState().scopeViewTargets).toEqual({});
    expect(holdScopeViewTarget("none", "project", undefined)).toBeFunction();
    expect(useInboxStore.getState().scopeViewTargets).toEqual({});
  });
});

describe("heads answers", () => {
  test("an unauthenticated heads answer revokes nothing", async () => {
    const tId = cid("projecttask");
    useInboxStore.setState({
      tasks: { [tId]: { _id: tId, workspace: `team:${T}`, project_id: P } },
      syncMeta: { [scopeMetaKey(`project:${P}`)]: { cursor: 4 } },
    } as any);
    await catchUp(
      heads(() => ({ heads: [], unauthenticated: true })),
      undefined,
      { scopes: [`project:${P}`] },
    );
    const s = useInboxStore.getState() as any;
    expect(s.tasks[tId]).toBeDefined();
    expect(s.scopeSubscriptions.denied[`project:${P}`]).toBeUndefined();
    expect(s.syncMeta[scopeMetaKey(`project:${P}`)]?.cursor).toBe(4);
  });

  test("an authenticated answer that omits a scope revokes it", async () => {
    const tId = cid("projecttask2");
    useInboxStore.setState({
      tasks: { [tId]: { _id: tId, workspace: `team:${T}`, project_id: P } },
      syncMeta: { [scopeMetaKey(`project:${P}`)]: { cursor: 4 } },
    } as any);
    await catchUp(
      heads(() => ({ heads: [] })),
      undefined,
      { scopes: [`project:${P}`] },
    );
    const s = useInboxStore.getState() as any;
    expect(s.tasks[tId]).toBeUndefined();
    expect(s.pending[`tasks:${tId}`]).toMatchObject({ type: "exclude" });
    expect(s.scopeSubscriptions.denied[`project:${P}`]).toBeDefined();
  });
});

describe("a scope with no cursor", () => {
  test("an evicted project that opens again refills its rows before its stamp", async () => {
    const tId = cid("evictedtask");
    useInboxStore.setState({
      tasks: { [tId]: { _id: tId, workspace: `team:${T}`, project_id: P } },
      syncMeta: {
        [scopeMetaKey(`project:${P}`)]: { cursor: 5 },
        [scopeMetaKey(`dir:${T}`)]: { cursor: 9 },
        [`tasks:v3:${JSON.stringify({ workspace: "team", team_id: T })}`]: {
          cursor: 100,
          backfilledAt: 100,
        },
      },
    } as any);
    useInboxStore
      .getState()
      .setScopeViewTargets("screen-p", [{ kind: "project", id: P }]);
    useInboxStore.getState().reconcileScopeSubscriptions(1000);
    useInboxStore.getState().setScopeViewTargets("screen-p", []);
    useInboxStore.getState().reconcileScopeSubscriptions(2000);
    const evicted = useInboxStore
      .getState()
      .reconcileScopeSubscriptions(200_000);
    expect(evicted.removedScopes).toContain(`project:${P}`);
    expect(useInboxStore.getState().tasks[tId]).toBeUndefined();
    expect(
      useInboxStore.getState().syncMeta[scopeMetaKey(`project:${P}`)],
    ).toBeUndefined();

    useInboxStore
      .getState()
      .setScopeViewTargets("screen-p", [{ kind: "project", id: P }]);
    useInboxStore.getState().reconcileScopeSubscriptions(210_000);
    const epochBefore = useInboxStore.getState().syncLogFloorEpoch;
    const order: string[] = [];
    const off = useInboxStore.subscribe((next, prev) => {
      if (next.syncLogFloorEpoch !== prev.syncLogFloorEpoch)
        order.push("recut");
      if (
        next.syncMeta[scopeMetaKey(`project:${P}`)]?.cursor !== undefined &&
        prev.syncMeta[scopeMetaKey(`project:${P}`)]?.cursor === undefined
      )
        order.push("cursor");
      if (
        next.syncLogScopeStamps[`project:${P}`] !== undefined &&
        prev.syncLogScopeStamps[`project:${P}`] === undefined
      )
        order.push("stamp");
    });
    await catchUp(
      heads((scopes) => ({
        heads: scopes.map((scope_key) => ({
          scope_key,
          position: scope_key === `project:${P}` ? 12 : 9,
          floor: 0,
        })),
      })),
    );
    off();
    const s = useInboxStore.getState() as any;
    expect(s.syncLogFloorEpoch).toBe(epochBefore + 1);
    expect(order).toEqual(["recut", "cursor", "stamp"]);
    expect(s.syncMeta[scopeMetaKey(`project:${P}`)].cursor).toBe(12);
    expect(s.syncMeta[scopeMetaKey(`dir:${T}`)].cursor).toBe(9);
    expect(
      s.syncMeta[
        `tasks:v3:${JSON.stringify({ workspace: "team", team_id: T })}`
      ],
    ).toBeUndefined();
  });

  test("one scope caught up on its own with no cursor recuts the floors", async () => {
    const order: string[] = [];
    const off = useInboxStore.subscribe((next, prev) => {
      if (next.syncLogFloorEpoch !== prev.syncLogFloorEpoch)
        order.push("recut");
      if (
        next.syncMeta[scopeMetaKey(`project:${P}`)]?.cursor !== undefined &&
        prev.syncMeta[scopeMetaKey(`project:${P}`)]?.cursor === undefined
      )
        order.push("cursor");
    });
    await catchUpScope(
      heads(() => ({ heads: [] })),
      { scope_key: `project:${P}`, position: 6, floor: 0 },
      new Set(),
    );
    off();
    expect(order).toEqual(["recut", "cursor"]);
    const s = useInboxStore.getState() as any;
    expect(s.syncMeta[scopeMetaKey(`project:${P}`)].cursor).toBe(6);
    expect(s.syncLogFloorEpoch).toBe(1);
  });

  test("a team scope with no cursor drops the team's crawl watermarks", async () => {
    const crawlKey = `tasks:v3:${JSON.stringify({ workspace: "team", team_id: T })}`;
    useInboxStore.setState({
      syncMeta: {
        [scopeMetaKey("user:u1")]: { cursor: 3 },
        [crawlKey]: { cursor: 100, backfilledAt: 100 },
      },
    } as any);
    await catchUp(
      heads((scopes) => ({
        heads: scopes.map((scope_key) => ({
          scope_key,
          position: 3,
          floor: 0,
        })),
      })),
      undefined,
      { scopes: ["user:u1", `dir:${T}`] },
    );
    const s = useInboxStore.getState() as any;
    expect(s.syncMeta[crawlKey]).toBeUndefined();
    expect(s.syncMeta[scopeMetaKey(`dir:${T}`)].cursor).toBe(3);
  });
});

describe("team revocation", () => {
  test("removes the team's project rows, their details and projects, even when pinned", () => {
    const tDir = cid("tdir");
    const tProj = cid("tproj");
    const dProj = cid("dproj");
    const tMine = cid("tmine");
    useInboxStore.setState({
      tasks: {
        [tDir]: { _id: tDir, workspace: `team:${T}` },
        [tProj]: { _id: tProj, workspace: `team:${T}`, project_id: P },
        [tMine]: { _id: tMine, workspace: "user:u1" },
      },
      taskComments: { [tProj]: { _id: tProj, comments: [] } },
      docs: { [dProj]: { _id: dProj, workspace: `team:${T}`, project_id: P } },
      docDetails: { [dProj]: { _id: dProj, content: "secret" } },
      projects: { [P]: { _id: P, workspace: `team:${T}` } },
    } as any);
    const release = pinDetailRows("docDetails", [dProj]);
    const releaseThread = pinDetailRows("taskComments", [tProj]);
    useInboxStore.getState().revokeTeamScope(T);
    release();
    releaseThread();
    const s = useInboxStore.getState() as any;
    expect(s.tasks[tDir]).toBeUndefined();
    expect(s.tasks[tProj]).toBeUndefined();
    expect(s.tasks[tMine]).toBeDefined();
    expect(s.taskComments[tProj]).toBeUndefined();
    expect(s.docs[dProj]).toBeUndefined();
    expect(s.docDetails[dProj]).toBeUndefined();
    expect(s.projects[P]).toBeUndefined();
    expect(s.pending[`tasks:${tProj}`]).toMatchObject({
      type: "exclude",
      scope: `dir:${T}`,
    });
    expect(s.scopeSubscriptions.denied[`dir:${T}`]).toBeDefined();
  });

  test("removes a team doc detail with no list row and the team's chat messages", () => {
    const dOrphan = cid("dorphan");
    const dMine = cid("dmine");
    const mTeam = cid("mteam");
    const mOther = cid("mother");
    useInboxStore.setState({
      docs: {},
      docDetails: {
        [dOrphan]: { _id: dOrphan, workspace: `team:${T}`, content: "secret" },
        [dMine]: { _id: dMine, workspace: "user:u1", content: "mine" },
      },
      chatMessages: {
        [mTeam]: { _id: mTeam, team_id: T, channel_id: "c1" },
        [mOther]: { _id: mOther, team_id: "team2", channel_id: "c2" },
      },
    } as any);
    const release = pinDetailRows("docDetails", [dOrphan]);
    useInboxStore.getState().revokeTeamScope(T);
    release();
    const s = useInboxStore.getState() as any;
    expect(s.docDetails[dOrphan]).toBeUndefined();
    expect(s.docDetails[dMine]).toBeDefined();
    expect(s.pending[`docs:${dOrphan}`]).toMatchObject({ type: "exclude" });
    expect(s.chatMessages[mTeam]).toBeUndefined();
    expect(s.chatMessages[mOther]).toBeDefined();
  });

  test("a host sends its revocation and a follower removes a pinned orphan detail", () => {
    const posted: any[] = [];
    const hostChannel = {
      post: (msg: any) => posted.push(msg),
      onMessage: () => () => {},
    };
    const host = createScopeViewTransport({
      selfId: "host",
      channel: hostChannel as any,
      getState: useInboxStore.getState,
      subscribe: useInboxStore.subscribe,
      onPeerView: () => {},
      onClearPeerViews: () => {},
      heartbeatMs: 0,
    });
    host.startHost();
    useInboxStore.getState().revokeTeamScope(T);
    host.stop();
    const revoke = posted.find((m) => Array.isArray(m.scopeRevoke));
    expect(revoke?.scopeRevoke).toEqual([`dir:${T}`]);

    const dOrphan = cid("dopenonfollower");
    useInboxStore.setState({
      syncRole: "follower",
      docs: {},
      docDetails: {
        [dOrphan]: { _id: dOrphan, workspace: `team:${T}`, content: "secret" },
      },
    } as any);
    const release = pinDetailRows("docDetails", [dOrphan]);
    let deliver: ((msg: any) => void) | undefined;
    const followerChannel = {
      post: () => {},
      onMessage: (cb: (msg: any) => void) => {
        deliver = cb;
        return () => {};
      },
    };
    const passed: any[] = [];
    const follower = createScopeViewTransport({
      selfId: "follower",
      channel: followerChannel as any,
      getState: useInboxStore.getState,
      subscribe: useInboxStore.subscribe,
      onPeerView: () => {},
      onClearPeerViews: () => {},
      onRevoke: (scopes) =>
        useInboxStore.getState().applyReplicatedScopeRevocation(scopes),
      heartbeatMs: 0,
    });
    const off = follower.channel.onMessage((m) => passed.push(m));
    deliver?.(revoke);
    off();
    release();
    expect(passed).toEqual([]);
    expect(useInboxStore.getState().docDetails[dOrphan]).toBeUndefined();
  });

  test("a follower drops a pinned detail row when its parent row is removed", () => {
    const tId = cid("tfollower");
    const dId = cid("dfollower");
    const tKept = cid("tkept");
    useInboxStore.setState({
      syncRole: "follower",
      tasks: {
        [tId]: { _id: tId, workspace: `team:${T}` },
        [tKept]: { _id: tKept, workspace: `team:${T}` },
      },
      taskComments: {
        [tId]: { _id: tId, comments: [] },
        [tKept]: { _id: tKept, comments: [] },
      },
      docs: { [dId]: { _id: dId, workspace: `team:${T}` } },
      docDetails: { [dId]: { _id: dId, content: "secret" } },
    } as any);
    const release = pinDetailRows("docDetails", [dId]);
    const releaseThreads = pinDetailRows("taskComments", [tId, tKept]);
    applyUpdatesToStore([
      { key: "docDetails", removes: [dId] },
      { key: "taskComments", removes: [tId, tKept] },
      { key: "docs", removes: [dId] },
      { key: "tasks", removes: [tId] },
    ]);
    release();
    releaseThreads();
    const s = useInboxStore.getState() as any;
    expect(s.docs[dId]).toBeUndefined();
    expect(s.docDetails[dId]).toBeUndefined();
    expect(s.taskComments[tId]).toBeUndefined();
    expect(s.taskComments[tKept]).toBeDefined();
  });
});
