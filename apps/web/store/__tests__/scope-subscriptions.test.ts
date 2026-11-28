import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { __cacheEvictionsIdleForTests } from "../cache-eviction";
import { pinDetailRows, resetDetailPins } from "../../lib/detail-rows";
import { useInboxStore } from "../inboxStore";
import { resetSyncTransactionForTests } from "../syncTransaction";
import {
  SCOPE_FOLLOW_WINDOW_MS,
  SCOPE_HEADS_CHUNK_SIZE,
  SCOPE_SUBSCRIPTION_BUDGET,
  SCOPE_VIEW_GRACE_MS,
  computePurgeSet,
  extractScopeCandidates,
  initialScopeSubscriptionState,
  reconcileScopeSubscriptions,
  rowHomeScope,
} from "../scope-subscriptions";

const cid = (label: string) =>
  label
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase()
    .padEnd(32, "0");

beforeEach(() => {
  resetDetailPins();
  useInboxStore.getState()._setOutbox(null, null, null);
  useInboxStore.getState()._setDispatch(null);
  useInboxStore.setState({
    currentUser: null,
    teams: [],
    projects: {},
    viewerRoles: {},
    chatChannels: {},
    chatReads: {},
    chatRail: [],
    clientState: { ui: {} } as any,
    clientStateInitialized: false,
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
    scopeSubscriptions: initialScopeSubscriptionState(),
  } as any);
});

afterEach(() => {
  resetDetailPins();
  resetSyncTransactionForTests();
  useInboxStore.getState()._setOutbox(null, null, null);
  useInboxStore.getState()._setDispatch(null);
  useInboxStore.getState()._setIDBWrite(null);
});

describe("scope-subscriptions pure core", () => {
  test("extracts pinned, membership, follows, and view while skipping personal and unresolved projects", () => {
    const now = 20 * 24 * 60 * 60 * 1000;
    const candidates = extractScopeCandidates(
      {
        currentUser: { _id: "u1" },
        teams: [{ _id: "t1" }, { _id: "team-stub-1" }],
        viewerRoles: {
          r1: {
            _id: "r1",
            host_user_id: "u1",
            status: "active",
            scope: { project_ids: ["p-role", "p-missing"] },
          },
          rRetired: {
            _id: "rRetired",
            host_user_id: "u1",
            status: "retired",
            scope: { project_ids: ["p-retired"] },
          },
          rOther: {
            _id: "rOther",
            host_user_id: "u2",
            status: "active",
            scope: { project_ids: ["p-other"] },
          },
        },
        projects: {
          "p-owned": { _id: "p-owned", user_id: "u1", workspace: "team:t1" },
          "p-personal": {
            _id: "p-personal",
            user_id: "u1",
            workspace: "user:u1",
          },
          "p-role": {
            _id: "p-role",
            user_id: "u2",
            short_id: "pj-role",
            workspace: "team:t1",
          },
          "p-retired": {
            _id: "p-retired",
            user_id: "u2",
            workspace: "team:t1",
          },
          "p-star": {
            _id: "p-star",
            user_id: "u2",
            short_id: "pj-star",
            workspace: "team:t1",
          },
          "p-recent": {
            _id: "p-recent",
            user_id: "u2",
            short_id: "pj-rec",
            workspace: "team:t1",
          },
          "p-old": {
            _id: "p-old",
            user_id: "u2",
            short_id: "pj-old",
            workspace: "team:t1",
          },
          "p-view": { _id: "p-view", user_id: "u2", workspace: "team:t1" },
          "p-peer": { _id: "p-peer", user_id: "u2", workspace: "team:t1" },
        },
        chatChannels: {
          "ch-open": { _id: "ch-open" },
          "ch-muted": { _id: "ch-muted" },
          "ch-muted-open": { _id: "ch-muted-open" },
          "ch-archived": { _id: "ch-archived", archived_at: 100 },
          "ch-unjoined": { _id: "ch-unjoined" },
          "chatstub-1": { _id: "chatstub-1" },
        },
        chatReads: {
          rd1: {
            channel_id: "ch-open",
            notify_level: "mentions",
            updated_at: 10,
          },
          rd2: { channel_id: "ch-muted", notify_level: "none", updated_at: 10 },
          rd3: {
            channel_id: "ch-muted-open",
            notify_level: "none",
            updated_at: 10,
          },
          rd4: {
            channel_id: "ch-archived",
            notify_level: "all",
            updated_at: 10,
          },
        },
        chatRail: [
          { channel_id: "ch-rail", joined: true, notify_level: "all" },
          { channel_id: "ch-unjoined", joined: false, notify_level: "all" },
        ],
        clientState: {
          ui: {
            sidebar_pins: [
              { kind: "project", id: "pj-star" },
              { kind: "project", id: "p-personal" },
              { kind: "project", id: "p-unknown" },
            ],
          },
        },
        recentVisits: [
          {
            kind: "page",
            key: "page:/projects/pj-rec",
            path: "/projects/pj-rec",
            ts: now - SCOPE_FOLLOW_WINDOW_MS,
          },
          {
            kind: "page",
            key: "page:/projects/pj-old",
            path: "/projects/pj-old",
            ts: now - SCOPE_FOLLOW_WINDOW_MS - 1,
          },
        ],
        activeTabId: "tab1",
        tabs: [
          {
            id: "tab1",
            path: "/projects/p-view",
            layout: {
              type: "split",
              children: [
                { type: "leaf", id: "l1", path: "/projects/p-view" },
                { type: "leaf", id: "l2", path: "/chat/ch-muted-open" },
                { type: "leaf", id: "l3", path: "/tasks/ct-9" },
                { type: "leaf", id: "l4", path: "/projects/%E0%A4%A" },
                { type: "leaf", id: "l5", path: "/projects/does-not-exist" },
              ],
            },
          },
        ],
        tasks: {
          [cid("task1")]: {
            _id: cid("task1"),
            short_id: "ct-9",
            home_scope: "project:p-task-view",
            workspace: "team:t1",
          },
        },
        scopeSubscriptions: {
          peerViews: {
            follower1: ["project:p-peer", "unknown:ignored"],
          },
        },
      },
      now,
    );

    expect(candidates.pinned.sort()).toEqual(["dir:t1", "user:u1"]);
    expect(candidates.membership.sort()).toEqual([
      "channel:ch-open",
      "channel:ch-rail",
      "project:p-owned",
      "project:p-role",
    ]);
    expect(candidates.follows).toEqual([
      { scope: "project:p-star", at: undefined },
      { scope: "project:p-recent", at: now - SCOPE_FOLLOW_WINDOW_MS },
    ]);
    expect(candidates.view.sort()).toEqual([
      "channel:ch-muted-open",
      "project:p-peer",
      "project:p-task-view",
      "project:p-view",
    ]);
  });

  test("enforces 64-scope budget, keeps user first over 64 pins, and puts current view ahead of lastUsedAt", () => {
    let state = initialScopeSubscriptionState();
    const pinned = [
      "user:u1",
      ...Array.from({ length: 69 }, (_, i) => `dir:t${i}`),
    ];
    const overPinned = reconcileScopeSubscriptions(
      state,
      { principalId: "u1", pinned, membership: [], follows: [], view: [] },
      1000,
    );
    expect(overPinned.activeScopes).toHaveLength(SCOPE_SUBSCRIPTION_BUDGET);
    expect(overPinned.activeScopes[0]).toBe("user:u1");

    state = initialScopeSubscriptionState();
    const membership = Array.from({ length: 62 }, (_, i) => `project:p${i}`);
    const follows = Array.from({ length: 62 }, (_, i) => ({
      scope: `project:p${i}`,
      at: i === 1 ? 1100 : 1200,
    }));
    const first = reconcileScopeSubscriptions(
      state,
      {
        principalId: "u1",
        pinned: ["user:u1", "dir:t1"],
        membership,
        follows,
        view: [],
      },
      1500,
    );
    state = first.state;

    const clampedFuture = reconcileScopeSubscriptions(
      initialScopeSubscriptionState(),
      {
        principalId: "u1",
        pinned: ["user:u1"],
        membership: ["project:pfuture"],
        follows: [{ scope: "project:pfuture", at: 99_999_999 }],
        view: [],
      },
      1500,
    );
    expect(clampedFuture.state.active["project:pfuture"].lastUsedAt).toBe(1500);

    const idleRepeat = reconcileScopeSubscriptions(
      state,
      {
        principalId: "u1",
        pinned: ["user:u1", "dir:t1"],
        membership,
        follows,
        view: [],
      },
      1600,
    );
    expect(idleRepeat.state).toBe(state);
    expect(idleRepeat.state.active).toBe(state.active);

    const second = reconcileScopeSubscriptions(
      state,
      {
        principalId: "u1",
        pinned: ["user:u1", "dir:t1"],
        membership,
        follows,
        view: ["project:p-view-now"],
      },
      1700,
    );
    expect(second.activeScopes).toHaveLength(SCOPE_SUBSCRIPTION_BUDGET);
    expect(second.activeScopes).toContain("user:u1");
    expect(second.activeScopes).toContain("dir:t1");
    expect(second.activeScopes).toContain("project:p-view-now");
    expect(second.evictedScopes).toEqual(["project:p1"]);

    const third = reconcileScopeSubscriptions(
      second.state,
      {
        principalId: "u1",
        pinned: ["user:u1", "dir:t1"],
        membership,
        follows: membership
          .filter((s) => s !== "project:p2")
          .map((scope) => ({ scope, at: 1800 })),
        view: ["project:p-view-2"],
      },
      1800,
    );
    expect(third.activeScopes).toContain("project:p-view-2");
    expect(third.activeScopes).not.toContain("project:p2");
  });

  test("starts 60 s grace on leaving view, clears on return, then expires", () => {
    let state = initialScopeSubscriptionState();
    const t0 = 10_000;
    const opened = reconcileScopeSubscriptions(
      state,
      {
        principalId: "u1",
        pinned: ["user:u1"],
        membership: [],
        follows: [],
        view: ["project:p-view"],
      },
      t0,
    );
    state = opened.state;
    expect(opened.activeScopes).toContain("project:p-view");
    expect(opened.nextGraceExpiryAt).toBeNull();
    expect(state.graceDeadlines).toEqual({});

    const stayedAt90s = t0 + 90_000;
    const left = reconcileScopeSubscriptions(
      state,
      {
        principalId: "u1",
        pinned: ["user:u1"],
        membership: [],
        follows: [],
        view: [],
      },
      stayedAt90s,
    );
    state = left.state;
    expect(left.activeScopes).toContain("project:p-view");
    expect(left.nextGraceExpiryAt).toBe(stayedAt90s + SCOPE_VIEW_GRACE_MS);

    const beforeExpiry = reconcileScopeSubscriptions(
      state,
      {
        principalId: "u1",
        pinned: ["user:u1"],
        membership: [],
        follows: [],
        view: [],
      },
      stayedAt90s + SCOPE_VIEW_GRACE_MS - 1,
    );
    state = beforeExpiry.state;
    expect(beforeExpiry.activeScopes).toContain("project:p-view");
    expect(beforeExpiry.expiredGraceScopes).toEqual([]);

    const returned = reconcileScopeSubscriptions(
      state,
      {
        principalId: "u1",
        pinned: ["user:u1"],
        membership: [],
        follows: [],
        view: ["project:p-view"],
      },
      stayedAt90s + SCOPE_VIEW_GRACE_MS - 1,
    );
    state = returned.state;
    expect(returned.nextGraceExpiryAt).toBeNull();
    expect(state.graceDeadlines).toEqual({});

    const leftAgainAt = stayedAt90s + 120_000;
    const leftAgain = reconcileScopeSubscriptions(
      state,
      {
        principalId: "u1",
        pinned: ["user:u1"],
        membership: [],
        follows: [],
        view: [],
      },
      leftAgainAt,
    );
    expect(leftAgain.nextGraceExpiryAt).toBe(leftAgainAt + SCOPE_VIEW_GRACE_MS);

    const atExpiry = reconcileScopeSubscriptions(
      leftAgain.state,
      {
        principalId: "u1",
        pinned: ["user:u1"],
        membership: [],
        follows: [],
        view: [],
      },
      leftAgainAt + SCOPE_VIEW_GRACE_MS,
    );
    expect(atExpiry.activeScopes).toEqual(["user:u1"]);
    expect(atExpiry.expiredGraceScopes).toEqual(["project:p-view"]);
    expect(atExpiry.removedScopes).toEqual(["project:p-view"]);
    expect(atExpiry.nextGraceExpiryAt).toBeNull();
  });

  test("preserves chunk assignments across additions, removals, and denied scopes", () => {
    let state = initialScopeSubscriptionState();
    const initialMembership = Array.from(
      { length: 20 },
      (_, i) => `project:p${String(i).padStart(2, "0")}`,
    );
    const r1 = reconcileScopeSubscriptions(
      state,
      {
        principalId: "u1",
        pinned: ["user:u1"],
        membership: initialMembership,
        follows: [],
        view: [],
      },
      1000,
    );
    state = r1.state;
    expect(state.chunks[0]).toHaveLength(SCOPE_HEADS_CHUNK_SIZE);
    expect(state.chunks[1]).toHaveLength(5);

    const prevChunk0 = state.chunks[0];
    const r2 = reconcileScopeSubscriptions(
      state,
      {
        principalId: "u1",
        pinned: ["user:u1"],
        membership: [...initialMembership, "project:p-added"],
        follows: [],
        view: [],
      },
      2000,
    );
    state = r2.state;
    expect(state.chunks[0]).toBe(prevChunk0);
    expect(state.chunks[1]).toContain("project:p-added");

    const withoutP00 = initialMembership.filter((s) => s !== "project:p00");
    const r3 = reconcileScopeSubscriptions(
      state,
      {
        principalId: "u1",
        pinned: ["user:u1"],
        membership: [...withoutP00, "project:p-added"],
        follows: [],
        view: [],
      },
      3000,
    );
    expect(r3.state.chunks[0]).toHaveLength(15);
    expect(r3.state.chunks[0]).not.toContain("project:p00");
  });

  test("protects local/pending/outbox/pinned/owned/unknown rows and evicts without excludes", () => {
    expect(
      rowHomeScope("tasks", {
        _id: cid("t1"),
        workspace: "team:team1",
        project_id: "p1",
      }),
    ).toBe("project:p1");
    expect(
      rowHomeScope("docs", {
        _id: cid("d1"),
        workspace: "team:team1",
      }),
    ).toBe("dir:team1");
    expect(
      rowHomeScope("plans", {
        _id: cid("pl1"),
        workspace: "restricted:org1",
        team_id: "team1",
      }),
    ).toBeNull();
    expect(
      rowHomeScope("tasks", {
        _id: cid("tnotws"),
        team_id: "team1",
      }),
    ).toBeNull();
    expect(
      rowHomeScope("docs", {
        _id: cid("dunknown"),
        home_scope: "session:s1",
      }),
    ).toBeNull();

    const idDrop = cid("tdrop");
    const idDocDrop = cid("ddrop");
    const idPlanDrop = cid("pldrop");
    const idMsgDrop = cid("mdrop");
    const idFieldLock = cid("tfield");
    const idIncludeLock = cid("tinclude");
    const idDocPinned = cid("ddetailpin");
    const idTaskPinned = cid("ttaskpin");
    const idUnsentRowComment = cid("tunsentrow");
    const idUnsentSplitComment = cid("tunsentsplit");
    const idOwnedByViewer = cid("towned");
    const idAssignedToViewer = cid("tassigned");
    const idOutboxChat = cid("moutbox");
    const idFailedChat = cid("mfailed");
    const idUnknownPrefix = cid("tunknownscope");

    const releaseDoc = pinDetailRows("docDetails", [idDocPinned]);
    const releaseTask = pinDetailRows("taskComments", [idTaskPinned]);

    const held = new Set(["user:u1", "dir:team1", "project:p-held"]);
    const purgeTargets = computePurgeSet(
      {
        currentUser: { _id: "u1" },
        tasks: {
          "docstub-not-convex": {
            _id: "docstub-not-convex",
            home_scope: "project:p-evicted",
          },
          [idDrop]: { _id: idDrop, home_scope: "project:p-evicted" },
          [idFieldLock]: { _id: idFieldLock, home_scope: "project:p-evicted" },
          [idIncludeLock]: {
            _id: idIncludeLock,
            home_scope: "project:p-evicted",
          },
          [idTaskPinned]: {
            _id: idTaskPinned,
            home_scope: "project:p-evicted",
          },
          [idUnsentRowComment]: {
            _id: idUnsentRowComment,
            home_scope: "project:p-evicted",
            comments: [{ _id: "temp_c1", text: "draft" }],
          },
          [idUnsentSplitComment]: {
            _id: idUnsentSplitComment,
            home_scope: "project:p-evicted",
          },
          [idOwnedByViewer]: {
            _id: idOwnedByViewer,
            user_id: "u1",
            home_scope: "project:p-evicted",
          },
          [idAssignedToViewer]: {
            _id: idAssignedToViewer,
            assignee: "u1",
            home_scope: "project:p-evicted",
          },
          [idUnknownPrefix]: {
            _id: idUnknownPrefix,
            home_scope: "future:scope1",
          },
        },
        taskComments: {
          [idUnsentSplitComment]: {
            _id: idUnsentSplitComment,
            comments: [{ _id: "temp_split", text: "unsent" }],
          },
        },
        docs: {
          "docstub-1": { _id: "docstub-1", home_scope: "project:p-evicted" },
          [idDocPinned]: { _id: idDocPinned, home_scope: "project:p-evicted" },
          [idDocDrop]: {
            _id: idDocDrop,
            workspace: "team:team1",
            project_id: "p-old",
          },
        },
        plans: {
          [idPlanDrop]: { _id: idPlanDrop, home_scope: "project:p-evicted" },
        },
        chatMessages: {
          "chatmsgstub-1": {
            _id: "chatmsgstub-1",
            channel_id: "ch-muted",
            content: "sending",
          },
          [idOutboxChat]: {
            _id: idOutboxChat,
            channel_id: "ch-muted",
            content: "edited offline",
          },
          [idFailedChat]: {
            _id: idFailedChat,
            channel_id: "ch-muted",
            content: "failed",
            _failedAt: 100,
          },
          [idMsgDrop]: { _id: idMsgDrop, channel_id: "ch-muted" },
        },
      },
      held,
      {
        pending: {
          [`tasks:${idFieldLock}:title`]: {
            type: "field",
            value: "locked",
            ts: 1,
          },
          [`tasks:${idIncludeLock}`]: {
            type: "include",
            ts: 1,
          },
        },
        protectedOutboxRows: new Set([`chatMessages:${idOutboxChat}`]),
        viewerId: "u1",
      },
    );
    releaseDoc();
    releaseTask();

    expect(purgeTargets).toEqual([
      { collection: "tasks", id: idDrop, scope: "project:p-evicted" },
      { collection: "docs", id: idDocDrop, scope: "project:p-old" },
      { collection: "plans", id: idPlanDrop, scope: "project:p-evicted" },
      { collection: "chatMessages", id: idMsgDrop, scope: "channel:ch-muted" },
    ]);

    const parkedOutbox: any[] = [];
    useInboxStore.getState()._setOutbox(
      async (entry) => {
        parkedOutbox.push(entry);
      },
      async () => {},
      async () => parkedOutbox,
    );

    const idStarTask = cid("tstar1");
    const idEditChat = cid("mreal1");
    useInboxStore.setState({
      currentUser: { _id: "u1" },
      teams: [{ _id: "team1" }],
      projects: { "p-star": { _id: "p-star", workspace: "team:team1" } },
      clientStateInitialized: true,
      clientState: {
        ui: { sidebar_pins: [{ kind: "project", id: "p-star" }] },
      } as any,
      tasks: {
        [idStarTask]: { _id: idStarTask, home_scope: "project:p-star" },
      },
      chatMessages: {
        [idEditChat]: {
          _id: idEditChat,
          channel_id: "ch-unsubscribed",
          content: "before edit",
          user_id: "u2",
        },
      },
      syncMeta: { "synclog:v1:project:p-star": { cursor: 5 } },
      syncLogScopeStamps: { "project:p-star": 100 },
    } as any);

    useInboxStore.getState().editChatMessage(idEditChat, "edited offline");

    const joinRes = useInboxStore.getState().reconcileScopeSubscriptions(1000);
    expect(joinRes.addedScopes).toContain("project:p-star");
    expect(__cacheEvictionsIdleForTests()).toBe(true);

    useInboxStore.setState({
      clientState: { ui: { sidebar_pins: [] } } as any,
    } as any);

    const dropRes = useInboxStore.getState().reconcileScopeSubscriptions(2000);
    expect(dropRes.removedScopes).toContain("project:p-star");
    expect(useInboxStore.getState().tasks[idStarTask]).toBeUndefined();
    expect(useInboxStore.getState().chatMessages[idEditChat]?.content).toBe(
      "edited offline",
    );
    expect(
      useInboxStore.getState().pending[`tasks:${idStarTask}`],
    ).toBeUndefined();
    expect(__cacheEvictionsIdleForTests()).toBe(true);

    useInboxStore
      .getState()
      .syncTable(
        "tasks",
        [{ _id: idStarTask, home_scope: "project:p-star", title: "Restored" }],
        { isDelta: true },
      );
    expect(useInboxStore.getState().tasks[idStarTask]?.title).toBe("Restored");
  });
});
