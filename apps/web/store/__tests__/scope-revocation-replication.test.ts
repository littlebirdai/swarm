import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useInboxStore } from "../inboxStore";
import { resetSyncTransactionForTests } from "../syncTransaction";
import { initialScopeSubscriptionState } from "../scope-subscriptions";
import {
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
});
