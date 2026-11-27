import { expect, spyOn, test } from "bun:test";
import { api } from "@codecast/convex/convex/_generated/api";
import { getFunctionName } from "convex/server";
import { act } from "react";
import { mountWeb } from "../../test-helpers/mountWeb";
import { webBuilders } from "../../test-helpers/builders";
import { useInboxStore } from "../../store/inboxStore";
import { useLiveInboxSessions } from "../useLiveInboxSessions";
import { scopeMetaKey } from "../use-sync-change-feed";
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
