import { expect, spyOn, test } from "bun:test";
import { api } from "@codecast/convex/convex/_generated/api";
import { getFunctionName } from "convex/server";
import { act } from "react";
import { mountWeb } from "../../test-helpers/mountWeb";
import { webBuilders } from "../../test-helpers/builders";
import { useInboxStore } from "../../store/inboxStore";
import { useLiveInboxSessions } from "../useLiveInboxSessions";
import { scopeMetaKey, useSyncChangeFeed } from "../use-sync-change-feed";
import { pending } from "../../test-helpers/testConvex";
import { emitSyncWake } from "../syncWake";
import { useQuery } from "convex/react";

const scope = "user:viewer";

function Inbox({ snapshot }: { snapshot: boolean }) {
  useQuery(api.syncLog.getHeads);
  const { loading } = useLiveInboxSessions(snapshot);
  return <span>{loading ? "loading" : "ready"}</span>;
}

test("the host reads one positioned snapshot and retries only on recovery", async () => {
  const row = webBuilders("inbox-log-snapshot").session.build();
  let position = 3;
  const random = spyOn(Math, "random").mockReturnValue(0.5);
  try {
    const { backend, clock, container, store } = await mountWeb(
      <Inbox snapshot />,
      {
        clock: true,
        setup(backend, state) {
          useInboxStore.setState({ syncRole: "host" });
          backend.set(api.syncLog.getHeads, { heads: [] });
          state.syncTable("currentUser", { _id: "viewer" });
          state.recordSyncMeta(scopeMetaKey(scope), { cursor: 4 });
          backend.set(api.conversations.listInboxSessions, () => ({
            sessions: [{ ...row, title: `Snapshot ${position}` }],
            hidden_count: 0,
            truncated: [],
            checkpoint: { scope, position },
          }));
        },
      },
    );
    const reads = () =>
      backend.queryRequests
        .filter(
          ({ name }) =>
            name === getFunctionName(api.conversations.listInboxSessions),
        )
        .map(({ args }) => args);
    await clock!.advance(1);
    expect(reads()).toEqual([
      expect.objectContaining({ checkpoint: true, _probe: expect.any(Number) }),
    ]);
    expect(store.getState().sessions[row._id]).toBeUndefined();
    expect(container.textContent).toBe("loading");
    position = 4;
    await clock!.advance(15_000);
    expect(reads()).toHaveLength(2);
    expect(store.getState().sessions[row._id]?.title).toBe("Snapshot 4");
    expect(store.getState().syncMeta[scopeMetaKey(scope)]?.cursor).toBe(4);
    expect(container.textContent).toBe("ready");
    for (let i = 0; i < 3; i++) {
      await clock!.advance(20_000);
      await act(async () => backend.ping());
    }
    expect(reads()).toHaveLength(2);
    await act(async () => emitSyncWake());
    await clock!.advance(7_500);
    expect(reads()).toHaveLength(3);
  } finally {
    random.mockRestore();
  }
});

test("the flag-off host still subscribes and an opted-in follower opens no inbox feed", async () => {
  const list = api.conversations.listInboxSessions;
  const { backend, clock, rerender } = await mountWeb(
    <Inbox snapshot={false} />,
    {
      clock: true,
      setup(backend) {
        useInboxStore.setState({ syncRole: "host" });
        backend.set(api.syncLog.getHeads, { heads: [] });
        backend.set(list, { sessions: [], hidden_count: 0, truncated: [] });
      },
    },
  );
  const reads = () =>
    backend.queryRequests.filter(({ name }) => name === getFunctionName(list));
  expect(reads()).toHaveLength(1);
  expect(reads()[0].args).toMatchObject({ split: true });
  await act(async () => useInboxStore.setState({ syncRole: "follower" }));
  await rerender(<Inbox snapshot />);
  await act(async () => emitSyncWake());
  await clock!.advance(30_000);
  expect(reads()).toHaveLength(1);
});

function InboxWithReplay() {
  useSyncChangeFeed();
  const { loading } = useLiveInboxSessions(true);
  return <span>{loading ? "loading" : "ready"}</span>;
}

test("one snapshot waits for the debounced replay cursor", async () => {
  const row = webBuilders("inbox-replay-debounce").session.build();
  const { backend, clock, store } = await mountWeb(<InboxWithReplay />, {
    clock: true,
    setup(backend, state) {
      useInboxStore.setState({
        syncRole: "host",
        clientStateInitialized: true,
      });
      state.syncTable("currentUser", { _id: "viewer" });
      state.recordSyncMeta(scopeMetaKey(scope), { cursor: 4 });
      backend.set(api.syncLog.getHeads, {
        heads: [{ scope_key: scope, position: 4, floor: 0 }],
      });
      backend.set(api.conversations.listInboxSessions, {
        sessions: [row],
        hidden_count: 0,
        truncated: [],
        checkpoint: { scope, position: 5 },
      });
      backend.set(api.syncLog.getRange, {
        actions: [],
        nextFrom: 5,
        hasMore: false,
      });
    },
  });
  await clock!.advance(1);
  await act(async () =>
    backend.set(api.syncLog.getHeads, {
      heads: [{ scope_key: scope, position: 5, floor: 0 }],
    }),
  );
  expect(store.getState().sessions[row._id]).toBeUndefined();
  await clock!.advance(1500);
  expect(store.getState().syncMeta[scopeMetaKey(scope)]?.cursor).toBe(5);
  expect(store.getState().sessions[row._id]?._id).toBe(row._id);
  expect(
    backend.queryRequests.filter(
      ({ name }) =>
        name === getFunctionName(api.conversations.listInboxSessions),
    ),
  ).toHaveLength(1);
});

test("a replay gap starts a new snapshot before the old request finishes", async () => {
  const row = webBuilders("inbox-gap-reset").session.build();
  const list = api.conversations.listInboxSessions;
  const reads = () =>
    backend.queryRequests.filter(({ name }) => name === getFunctionName(list));
  let firstProbe: number | undefined;
  const { backend, clock, store } = await mountWeb(<InboxWithReplay />, {
    clock: true,
    setup(backend, state) {
      useInboxStore.setState({
        syncRole: "host",
        clientStateInitialized: true,
      });
      state.syncTable("currentUser", { _id: "viewer" });
      state.recordSyncMeta(scopeMetaKey(scope), { cursor: 4 });
      backend.set(api.syncLog.getHeads, {
        heads: [{ scope_key: scope, position: 4, floor: 0 }],
      });
      backend.set(list, ({ _probe }) => {
        firstProbe ??= _probe;
        return _probe === firstProbe
          ? pending
          : {
              sessions: [{ ...row, title: "Replacement" }],
              hidden_count: 0,
              truncated: [],
              checkpoint: { scope, position: 8 },
            };
      });
    },
  });
  await clock!.advance(1);
  expect(reads()).toHaveLength(1);
  await act(async () =>
    backend.set(api.syncLog.getHeads, {
      heads: [{ scope_key: scope, position: 8, floor: 7 }],
    }),
  );
  await clock!.advance(1500);
  await clock!.advance(1);
  expect(reads()).toHaveLength(2);
  expect(store.getState().sessions[row._id]?.title).toBe("Replacement");
  await act(async () =>
    backend.set(list, {
      sessions: [{ ...row, title: "Superseded" }],
      hidden_count: 0,
      truncated: [],
      checkpoint: { scope, position: 8 },
    }),
  );
  expect(store.getState().sessions[row._id]?.title).toBe("Replacement");
});
