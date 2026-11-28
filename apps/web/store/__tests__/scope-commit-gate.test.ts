import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  getUndoHistory,
  _resetUndoStacks,
  performUndo,
  pushUndo,
} from "@platform/engine";
import { useInboxStore } from "../inboxStore";
import { resetSyncTransactionForTests } from "../syncTransaction";
import { initialScopeSubscriptionState } from "../scope-subscriptions";
import { holdTaskThreads } from "../../hooks/useSyncTasks";

const cid = (label: string) =>
  label
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase()
    .padEnd(32, "0");

const T = "teamgate";
const P = cid("projectgate");
const held = cid("tasknowrevoked");

beforeEach(() => {
  _resetUndoStacks();
  const s = useInboxStore.getState();
  s._setOutbox(null, null, null);
  s._setDispatch(null);
  s._setIDBWrite(null);
  useInboxStore.setState({
    currentUser: { _id: "u1" },
    teams: [{ _id: T }],
    syncRole: "follower",
    pending: {},
    projects: {},
    tasks: { [held]: { _id: held, workspace: "user:u1", title: "mine" } },
    taskComments: {},
    docs: {},
    docDetails: {},
    plans: {},
    chatMessages: {},
    feedConversations: {},
    mentionIndex: { tasks: {}, docs: {}, plans: {} },
    scopeSubscriptions: initialScopeSubscriptionState(),
    scopeRevocations: {},
  } as any);
  useInboxStore
    .getState()
    .applyReplicatedScopeRevocations({ [`dir:${T}`]: 5, [`project:${P}`]: 6 });
});

afterEach(() => {
  _resetUndoStacks();
  resetSyncTransactionForTests();
});

const state = () => useInboxStore.getState() as any;

describe("the commit gate drops rows of a revoked scope on every write", () => {
  test("an optimistic task create", () => {
    void Promise.resolve(
      state().createTask({ title: "x", team_id: T, client_key: "gatekey1" }),
    ).catch(() => {});
    const stubs = Object.values(state().tasks).filter(
      (t: any) => t.title === "x",
    );
    expect(stubs).toEqual([]);
  });

  test("an optimistic doc and project create", () => {
    void Promise.resolve(
      state().createDoc({
        title: "d",
        workspace: "team",
        team_id: T,
        client_key: "docstub-gate",
      }),
    ).catch(() => {});
    void Promise.resolve(
      state().createProject({
        title: "p",
        workspace: "team",
        team_id: T,
        client_key: "projstub-gate",
      }),
    ).catch(() => {});
    expect(
      Object.values(state().docs).filter((d: any) => d.title === "d"),
    ).toEqual([]);
    expect(
      Object.values(state().projects).filter((p: any) => p.title === "p"),
    ).toEqual([]);
  });

  test("a chat send painted into a revoked channel", () => {
    state().applyReplicatedScopeRevocations({
      [`dir:${T}`]: 5,
      [`project:${P}`]: 6,
      "channel:c1": 7,
    });
    state().paintChatSend("c1", "hello", "client-gate-1", {});
    state().paintChatSend("c2", "kept", "client-gate-2", {});
    const contents = Object.values(state().chatMessages).map(
      (m: any) => m.content,
    );
    expect(contents).toEqual(["kept"]);
  });

  test("a create receipt that seeds the row", () => {
    const id = cid("seededdoc");
    state()._handleReceiptAcknowledgement(
      "createDoc",
      { kind: "navigate", path: `/docs/${id}` },
      { row: { _id: id, workspace: `team:${T}`, title: "seeded" } },
      "cmd-1",
    );
    expect(state().docs[id]).toBeUndefined();
  });

  test("a replicated field write that moves a held row into the revoked team", () => {
    state().applyReplicatedFields("tasks", {
      [held]: { workspace: `team:${T}` },
    });
    expect(state().tasks[held]).toBeUndefined();
    expect(state().pending[`tasks:${held}`]).toMatchObject({ type: "exclude" });
  });

  test("a cargo patch that moves a held row into the revoked project", () => {
    useInboxStore.setState({
      tasks: { [held]: { _id: held, workspace: `team:other`, title: "t" } },
    } as any);
    state().applyCargoBatch([
      { coll: "tasks", id: held, fields: { project_id: P }, unset: [] },
    ]);
    expect(state().tasks[held]).toBeUndefined();
  });

  test("the mention index and the team feed cache", () => {
    const id = cid("mentioned");
    state().syncMentionIndex("tasks", [
      { _id: id, workspace: `team:${T}`, title: "m" },
      { _id: held, workspace: "user:u1", title: "mine" },
    ]);
    expect(Object.keys(state().mentionIndex.tasks)).toEqual([held]);
    state().mergeFeedConversations(`${T}|`, [{ _id: "c", updated_at: 1 }]);
    state().mergeFeedConversations(`other|`, [{ _id: "d", updated_at: 1 }]);
    expect(Object.keys(state().feedConversations)).toEqual(["other|"]);
  });

  test("a comment thread written before its task", () => {
    const id = cid("threadfirst");
    holdTaskThreads([
      { _id: id, workspace: `team:${T}`, comments: [{ _id: "c1" }] },
    ]);
    expect(state().taskComments[id]).toBeUndefined();
    expect(state().tasks[id]).toBeUndefined();
    const mine = cid("threadmine");
    holdTaskThreads([
      { _id: mine, workspace: "user:u1", comments: [{ _id: "c2" }] },
    ]);
    expect(state().taskComments[mine]?.workspace).toBe("user:u1");
  });

  test("an undo that moves a row back into the revoked team", async () => {
    const owner = {};
    state()._setDispatch(async () => null, { owner });
    try {
      useInboxStore.setState({
        scopeRevocations: {},
        scopeSubscriptions: initialScopeSubscriptionState(),
        tasks: {
          [held]: {
            _id: held,
            short_id: "ct-gate",
            workspace: `team:${T}`,
            team_id: T,
            title: "t",
            updated_at: 1,
          },
        },
      } as any);
      state().updateTask("ct-gate", {
        workspace: "user:u1",
        team_id: undefined,
      });
      expect(state().tasks[held]?.workspace).toBe("user:u1");
      state().applyReplicatedScopeRevocations({ [`dir:${T}`]: 9 });
      expect(state().tasks[held]).toBeDefined();
      performUndo();
      expect(state().tasks[held]).toBeUndefined();
    } finally {
      state()._clearDispatch(owner);
    }
  });

  test("a revocation forgets the undo entries of its rows", () => {
    useInboxStore.setState({
      scopeRevocations: {},
      tasks: {
        [held]: { _id: held, workspace: `team:${T}`, title: "t" },
      },
    } as any);
    pushUndo({
      label: "edit",
      undo: () => {},
      redo: () => {},
      mode: "manual",
      changes: [
        {
          store: "tasks",
          id: held,
          field: "title",
          before: "a",
          after: "t",
          hadBefore: true,
          hadAfter: true,
          kind: "protected",
        },
      ],
    } as any);
    expect(getUndoHistory().items.length).toBe(1);
    state().applyReplicatedScopeRevocations({ [`dir:${T}`]: 9 });
    expect(state().tasks[held]).toBeUndefined();
    expect(getUndoHistory().items.length).toBe(0);
  });
});

test("the gate costs nothing without a revocation", () => {
  useInboxStore.setState({ scopeRevocations: {} } as any);
  state().syncMentionIndex("tasks", [
    { _id: cid("free"), workspace: `team:${T}`, title: "m" },
  ]);
  expect(Object.keys(state().mentionIndex.tasks)).toEqual([cid("free")]);
});

test("an eviction removes the detail rows with their parents", () => {
  const id = cid("evictedparent");
  useInboxStore.setState({
    scopeRevocations: {},
    tasks: { [id]: { _id: id, workspace: "team:other", project_id: "pz" } },
    taskComments: {
      [id]: { _id: id, workspace: "team:other", comments: [] },
    },
  } as any);
  state().purgeUnheldScopeRows(new Set(["user:u1"]));
  expect(state().tasks[id]).toBeUndefined();
  expect(state().taskComments[id]).toBeUndefined();
});
