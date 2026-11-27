import { expect, jest, test } from "bun:test";
import {
  createReplicationFollower,
  createReplicationHost,
  type ReplicationUpdate,
} from "@platform/engine";
import {
  scopedFollowerChannel,
  scopedHostChannel,
} from "../desktop-panel-transport";
import { replicationTransport } from "../storage-transport";
import {
  replicationFollowerFor,
  replicationHostFor,
} from "../sync-replication";
import { useInboxStore } from "../inboxStore";

test("the scoped snapshot and updates carry only requested keys and preserve their sequence", async () => {
  const name = `test-scope-${crypto.randomUUID()}`;
  const legacy = replicationTransport(name, "host");
  const modern = scopedHostChannel(name, "host", legacy.channel);
  modern.activate();
  const host = replicationHostFor("host", modern.channel, () => ({
    docs: { one: { _id: "one", title: "Initial doc" } },
    tasks: { two: { _id: "two", title: "Excluded task" } },
  }));
  const received: ReplicationUpdate[] = [];
  let usedLegacy = false;
  const scope = scopedFollowerChannel(name, "panel", ["docs"], () => {
    usedLegacy = true;
    return replicationTransport(name, "panel");
  });
  const ready = Promise.withResolvers<void>();
  const live = Promise.withResolvers<void>();
  let joins = 0;
  const follower = createReplicationFollower({
    selfId: "panel",
    channel: scope.channel,
    replicatedKeys: ["docs", "tasks"],
    isCollectionKey: () => true,
    applyUpdates(batch) {
      received.push(...batch);
      if (batch.some(({ upserts }) => upserts?.[0]?.title === "Live doc"))
        live.resolve();
    },
    onSynced(synced) {
      if (synced) {
        joins++;
        ready.resolve();
      }
    },
  });
  try {
    await ready.promise;
    expect(received.flatMap(({ upserts }) => upserts ?? [])).toEqual([
      { _id: "one", title: "Initial doc" },
    ]);
    host.publish([
      { key: "tasks", upserts: [{ _id: "two", title: "Live task" }] },
    ]);
    host.publish([
      { key: "docs", upserts: [{ _id: "one", title: "Live doc" }] },
    ]);
    await live.promise;
    expect(received.every(({ key }) => key === "docs")).toBe(true);
    expect(joins).toBe(1);
    expect(follower.synced()).toBe(true);
    expect(usedLegacy).toBe(false);
  } finally {
    follower.stop();
    scope.close();
    host.stop();
    modern.close();
    legacy.close();
  }
});

test("a legacy host's snapshot and updates are filtered before entering the panel store", async () => {
  const name = `test-legacy-${crypto.randomUUID()}`;
  const doc = { _id: "legacy-doc", title: "Visible" };
  const task = { _id: "legacy-task", title: "Excluded" };
  const legacy = replicationTransport(name, "old-host");
  const host = createReplicationHost({
    hostId: "old-host",
    channel: legacy.channel,
    getState: () => ({ docs: { [doc._id]: doc }, tasks: { [task._id]: task } }),
    replicatedKeys: ["docs", "tasks"],
    isCollectionKey: () => true,
    applyUpdates() {},
  });
  const original = useInboxStore.getState();
  useInboxStore.setState({ syncRole: "follower" });
  jest.useFakeTimers();
  const scope = scopedFollowerChannel(name, "panel", ["docs"], () =>
    replicationTransport(name, "panel"),
  );
  const ready = Promise.withResolvers<void>();
  const follower = replicationFollowerFor(
    "panel",
    scope.channel,
    (synced) => {
      if (synced) ready.resolve();
    },
    undefined,
    ["docs"],
  );
  try {
    jest.advanceTimersByTime(2001);
    jest.useRealTimers();
    await ready.promise;
    expect(useInboxStore.getState().docs[doc._id]?.title).toBe(doc.title);
    expect(useInboxStore.getState().tasks[task._id]).toBeUndefined();

    const updated = Promise.withResolvers<void>();
    const stop = useInboxStore.subscribe((state) => {
      if (state.docs[doc._id]?.title === "Updated") updated.resolve();
    });
    try {
      host.publish([
        { key: "tasks", upserts: [{ ...task, title: "Unwanted update" }] },
        { key: "docs", upserts: [{ ...doc, title: "Updated" }] },
      ]);
      await updated.promise;
      expect(useInboxStore.getState().tasks[task._id]).toBeUndefined();
    } finally {
      stop();
    }
  } finally {
    follower.stop();
    scope.close();
    host.stop();
    legacy.close();
    jest.useRealTimers();
    useInboxStore.setState(original, true);
  }
});

test("a panel rejoins when a scoped host disappears", async () => {
  const name = `test-handoff-${crypto.randomUUID()}`;
  jest.useFakeTimers();
  const first = replicationTransport(name, "first");
  const scopedHost = scopedHostChannel(name, "first", first.channel);
  scopedHost.activate();
  const host = replicationHostFor("first", scopedHost.channel, () => ({
    docs: { row: { _id: "row", title: "First host" } },
  }));
  const scope = scopedFollowerChannel(name, "panel", ["docs"], () =>
    replicationTransport(name, "panel"),
  );
  const ready = Promise.withResolvers<void>();
  const replaced = Promise.withResolvers<void>();
  const roles: boolean[] = [];
  const follower = createReplicationFollower({
    selfId: "panel",
    channel: scope.channel,
    replicatedKeys: ["docs"],
    isCollectionKey: () => true,
    applyUpdates(batch) {
      const title = batch.find(({ key }) => key === "docs")?.upserts?.[0]
        ?.title;
      if (title === "First host") ready.resolve();
      if (title === "Replacement host") replaced.resolve();
    },
    onSynced(synced) {
      roles.push(synced);
    },
  });
  const replacement = replicationTransport(name, "replacement");
  let replacementHost: ReturnType<typeof createReplicationHost> | undefined;
  try {
    await ready.promise;
    host.stop();
    scopedHost.close();
    first.close();
    replacementHost = createReplicationHost({
      hostId: "replacement",
      channel: replacement.channel,
      getState: () => ({
        docs: { row: { _id: "row", title: "Replacement host" } },
      }),
      replicatedKeys: ["docs"],
      isCollectionKey: () => true,
      applyUpdates() {},
    });
    jest.advanceTimersByTime(6001);
    jest.useRealTimers();
    await replaced.promise;
    expect(roles).toEqual([true, false, true]);
  } finally {
    follower.stop();
    scope.close();
    replacementHost?.stop();
    replacement.close();
    host.stop();
    scopedHost.close();
    first.close();
    jest.useRealTimers();
  }
});
