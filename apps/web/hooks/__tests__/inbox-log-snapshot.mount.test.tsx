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
  const position = 3;
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
    expect(store.getState().sessions[row._id]?.title).toBe("Snapshot 3");
    expect(store.getState().syncMeta[scopeMetaKey(scope)]?.cursor).toBe(4);
    expect(container.textContent).toBe("ready");
    for (let i = 0; i < 3; i++) {
      await clock!.advance(20_000);
      await act(async () => backend.ping());
    }
    expect(reads()).toHaveLength(1);
    await act(async () => emitSyncWake());
    await clock!.advance(7_500);
    expect(reads()).toHaveLength(2);
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

const list = api.conversations.listInboxSessions;
const heads = api.syncLog.getHeads;
const range = api.syncLog.getRange;
const byIds = api.conversations.getInboxSessionsByIds;

const headAt = (position: number) => ({
  heads: [{ scope_key: scope, position, floor: 0 }],
});

const snapshotAt = (position: number, sessions: unknown[]) => ({
  sessions,
  hidden_count: 0,
  truncated: [],
  checkpoint: { scope, position },
});

const edit = (id: string, position: number, title: string) => ({
  entity_type: "conversations",
  entity_id: id,
  position,
  op: "upsert" as const,
  patch: { title },
});

test("the snapshot settles on the first attempt while writes move the log past its checkpoint", async () => {
  const build = webBuilders("busy-inbox").session.build;
  const row = build({ title: "At snapshot" });
  const latest = build({ title: "Latest at snapshot" });
  const unrelated = build({ title: "Unrelated original" });
  const claimed = build({
    user_id: "runner",
    owner_user_id: "viewer",
    owned_by_me: true,
    team_id: "team",
  });
  const { backend, clock, container, store } = await mountWeb(
    <InboxWithReplay />,
    {
      clock: true,
      setup(backend, state) {
        useInboxStore.setState({
          syncRole: "host",
          clientStateInitialized: true,
        });
        state.syncTable("currentUser", { _id: "viewer" });
        state.syncTable("sessions", [unrelated]);
        state.recordSyncMeta(scopeMetaKey(scope), { cursor: 4 });
        backend.set(heads, headAt(4));
        backend.set(list, pending);
        backend.set(byIds, ({ ids }) => ({
          sessions: ids.includes(latest._id) ? [latest] : [],
        }));
        backend.set(range, {
          actions: [
            edit(latest._id, 5, "Earlier than snapshot"),
            {
              entity_type: "session_owner",
              entity_id: `session-owner:${claimed._id}`,
              position: 6,
              op: "scope_removed",
            },
            edit(unrelated._id, 7, "Unrelated replay"),
            edit(row._id, 8, "Newest replay"),
          ],
          nextFrom: 8,
          hasMore: false,
        });
      },
    },
  );
  const titles: string[] = [];
  const off = store.subscribe((state) => {
    const title = state.sessions[latest._id]?.title;
    if (title !== undefined) titles.push(title);
  });
  try {
    await clock!.advance(1);
    for (const position of [5, 6, 8]) {
      await act(async () => backend.set(heads, headAt(position)));
      await clock!.advance(1000);
    }
    await act(async () =>
      backend.set(list, snapshotAt(6, [row, latest, claimed])),
    );
    await clock!.advance(1500);
    expect(container.textContent).toBe("ready");
    expect(store.getState().syncMeta[scopeMetaKey(scope)]?.cursor).toBe(8);
    expect(store.getState().sessions[row._id]?.title).toBe("Newest replay");
    expect(store.getState().sessions[unrelated._id]?.title).toBe(
      "Unrelated replay",
    );
    expect(store.getState().sessions[claimed._id]).toMatchObject({
      owned_by_me: false,
      team_id: "team",
    });
    expect(store.getState().liveInboxIds.has(claimed._id)).toBe(false);
    expect(titles).toContain("Latest at snapshot");
    expect(titles).not.toContain("Earlier than snapshot");
    const original = store.getState().sessions[latest._id];
    await act(async () => {
      backend.set(range, {
        actions: [edit(latest._id, 9, "Latest at snapshot")],
        nextFrom: 9,
        hasMore: false,
      });
      backend.set(heads, headAt(9));
    });
    await clock!.advance(1500);
    expect(store.getState().syncMeta[scopeMetaKey(scope)]?.cursor).toBe(9);
    expect(store.getState().sessions[latest._id]).toBe(original);
    expect(
      backend.queryRequests.filter(
        ({ name }) => name === getFunctionName(list),
      ),
    ).toHaveLength(1);
  } finally {
    off();
  }
});

test("a snapshot read waits for a replay page suspended in by-IDs work", async () => {
  const build = webBuilders("inbox-replay-await").session.build;
  const row = build({ title: "Before" });
  const fetched = build();
  let releasePage = false;
  const { backend, clock, container, store } = await mountWeb(
    <InboxWithReplay />,
    {
      clock: true,
      setup(backend, state) {
        useInboxStore.setState({
          syncRole: "host",
          clientStateInitialized: true,
        });
        state.syncTable("currentUser", { _id: "viewer" });
        state.syncTable("sessions", [row]);
        state.recordSyncMeta(scopeMetaKey(scope), { cursor: 4 });
        backend.set(heads, headAt(6));
        backend.set(byIds, pending);
        backend.set(list, () =>
          releasePage
            ? snapshotAt(6, [{ ...row, title: "Newer" }])
            : snapshotAt(4, [row]),
        );
        backend.set(range, {
          actions: [
            edit(row._id, 5, "Newer"),
            {
              entity_type: "conversations",
              entity_id: fetched._id,
              position: 6,
              op: "upsert",
            },
          ],
          nextFrom: 6,
          hasMore: false,
        });
      },
    },
  );
  expect(store.getState().sessions[row._id]?.title).toBe("Newer");
  expect(store.getState().syncMeta[scopeMetaKey(scope)]?.cursor).toBe(4);
  await clock!.advance(1);
  expect(
    backend.queryRequests.filter(({ name }) => name === getFunctionName(list)),
  ).toHaveLength(0);
  expect(store.getState().sessions[row._id]?.title).toBe("Newer");
  expect(container.textContent).toBe("loading");
  releasePage = true;
  await act(async () => backend.set(byIds, { sessions: [fetched] }));
  expect(store.getState().syncMeta[scopeMetaKey(scope)]?.cursor).toBe(6);
  expect(store.getState().sessions[row._id]?.title).toBe("Newer");
  expect(
    backend.queryRequests.filter(({ name }) => name === getFunctionName(list)),
  ).toHaveLength(1);
  expect(container.textContent).toBe("ready");
});

test("a replay gap starts a new snapshot before the old request finishes", async () => {
  const row = webBuilders("inbox-gap-reset").session.build();
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
