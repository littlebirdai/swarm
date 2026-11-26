import { afterEach, expect, jest, spyOn, test } from "bun:test";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { getFunctionName } from "convex/server";
import { act } from "react";
import {
  emptyInboxTally,
  INBOX_PROJECTION_VERSION,
  type InboxProjection,
} from "@codecast/inbox/inboxProjection";
import { mountWeb } from "../../test-helpers/mountWeb";
import type { testConvex } from "../../test-helpers/testConvex";
import { emitSyncWake } from "../syncWake";
import { useInboxDigestCompare } from "../useInboxDigestCompare";
import { useSyncInboxSessions } from "../useSyncInboxSessions";
import { useSyncTeamInboxSessions } from "../useSyncTeamInboxSessions";

function Feeders() {
  const recovery = useSyncInboxSessions();
  useSyncTeamInboxSessions();
  useInboxDigestCompare(recovery);
  return null;
}

const inbox = [
  api.conversations.listInboxSessions,
  api.conversations.sessionsLiveness,
  api.conversations.listTeamInboxSessions,
  api.conversations.teamSessionsLiveness,
] as const;
const names = inbox.map(getFunctionName).sort();
const list = { sessions: [], hidden_count: 0, truncated: [] };
const liveness = {
  liveness: {},
  projection: {
    v: INBOX_PROJECTION_VERSION,
    epoch: 0,
    set_digest: "quiet-inbox",
    user_id: "viewer",
    scope: "mine",
    team_id: null,
    tally: { shown: emptyInboxTally(), folded: emptyInboxTally() },
    truncated: [],
  } satisfies InboxProjection,
};
function setInboxQueries(
  backend: ReturnType<typeof testConvex>,
  error?: Error,
) {
  const reply =
    <T,>(data: T) =>
    ({ _probe }: { _probe?: number }) =>
      _probe === undefined && error ? error : data;
  backend.set(api.conversations.listInboxSessions, reply(list));
  backend.set(
    api.conversations.listTeamInboxSessions,
    reply({ ...list, team_id: null }),
  );
  backend.set(api.conversations.sessionsLiveness, reply(liveness));
  backend.set(api.conversations.teamSessionsLiveness, reply(liveness));
}

async function mountInbox() {
  const random = spyOn(Math, "random").mockReturnValue(0.5);
  restoreRandom = () => random.mockRestore();
  const mount = await mountWeb(<Feeders />, {
    clock: true,
    setup(backend) {
      backend.set(api.client_state.get, {
        _id: "client-state" as Id<"client_state">,
        _creationTime: Date.now(),
        user_id: "viewer" as Id<"users">,
        updated_at: Date.now(),
        ui: { inbox_scope: "team" },
      });
      backend.set(api.users.getCurrentUser, undefined);
      backend.set(api.users.getCurrentUserProbe, undefined);
      backend.set(api.bookmarks.listBookmarks, undefined);
      backend.set(api.conversations.listFavoriteSessions, undefined);
      setInboxQueries(backend);
    },
  });
  const { backend } = mount;
  const probes = () =>
    backend.queryRequests.flatMap(({ name, args }) =>
      names.includes(name) &&
      args !== null &&
      typeof args === "object" &&
      "_probe" in args &&
      typeof args._probe === "number"
        ? [{ name, at: args._probe }]
        : [],
    );
  expect(
    backend.queryRequests
      .filter(({ name }) => names.includes(name))
      .map(({ name }) => name)
      .sort(),
  ).toEqual(names);
  return { ...mount, clock: mount.clock!, probes };
}

let restoreRandom: (() => void) | undefined;
afterEach(() => {
  restoreRandom?.();
  restoreRandom = undefined;
});

test("quiet healthy personal and team subscriptions make no recovery reads", async () => {
  const { backend, clock, probes, store } = await mountInbox();
  const start = Date.now();
  const monotonic = spyOn(performance, "now").mockImplementation(
    () => Date.now() - start,
  );
  try {
    await clock.advance(301);
    expect(store.getState().sessionsProjection.mine?.set_digest).toBe(
      "quiet-inbox",
    );
    const before = backend.client.connectionState().connectionCount;
    for (let i = 0; i < 18; i++) {
      await clock.advance(20_000);
      await act(async () => backend.ping());
    }
    expect(backend.client.connectionState()).toMatchObject({
      isWebSocketConnected: true,
      connectionCount: before,
    });
    expect(probes()).toEqual([]);
  } finally {
    monotonic.mockRestore();
  }
});

test("reconnect schedules one jittered read per inbox query", async () => {
  const { backend, clock, probes } = await mountInbox();
  let reconnectedAt: number | undefined;
  const off = backend.client.subscribeToConnectionState((state) => {
    if (state.isWebSocketConnected) reconnectedAt ??= Date.now();
  });
  await act(async () => backend.disconnect());
  expect(backend.client.connectionState().isWebSocketConnected).toBe(false);
  expect(probes()).toEqual([]);
  await clock.advance(3_000);
  off();
  expect(reconnectedAt).toBeDefined();
  await clock.advance(reconnectedAt! + 7_499 - Date.now());
  expect(probes()).toEqual([]);
  await clock.advance(1);
  expect(
    probes()
      .map(({ name }) => name)
      .sort(),
  ).toEqual(names);
  await clock.advance(30_000);
  expect(probes()).toHaveLength(4);
});

test("resume schedules one read per inbox query", async () => {
  const { clock, probes } = await mountInbox();
  await act(async () => emitSyncWake());
  await clock.advance(7_499);
  expect(probes()).toEqual([]);
  await clock.advance(1);
  expect(
    probes()
      .map(({ name }) => name)
      .sort(),
  ).toEqual(names);
  await clock.advance(30_000);
  expect(probes()).toHaveLength(4);
});

test("a suspended clock wakes all four recovery readers", async () => {
  const { clock, probes } = await mountInbox();
  jest.setSystemTime(Date.now() + 60_000);
  await clock.advance(15_000);
  expect(probes()).toEqual([]);
  await clock.advance(7_500);
  expect(
    probes()
      .map(({ name }) => name)
      .sort(),
  ).toEqual(names);
});

test("successive subscription errors allow one read per query every 15 seconds", async () => {
  const { backend, clock, probes } = await mountInbox();
  const reportErrors = (message: string) =>
    act(async () => setInboxQueries(backend, new Error(message)));

  await reportErrors("inbox error 1");
  await clock.advance(7_500);
  expect(
    probes()
      .map(({ name }) => name)
      .sort(),
  ).toEqual(names);
  await reportErrors("inbox error 2");
  await clock.advance(1_000);
  await reportErrors("inbox error 3");
  await clock.advance(13_999);
  expect(probes()).toHaveLength(4);
  await clock.advance(1);
  expect(
    probes()
      .slice(4)
      .map(({ name }) => name)
      .sort(),
  ).toEqual(names);
  expect(probes()[4].at - probes()[0].at).toBe(15_000);
});
