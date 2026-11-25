import { api } from "@codecast/convex/convex/_generated/api";
import type { Value } from "convex/values";
import type { FunctionReturnType } from "convex/server";
import { mountWeb } from "../../test-helpers/mountWeb";
import {
  FakeRoom,
  standInForLiveKitRoom,
} from "../../test-helpers/LiveKitRoomStandIn";
import type { WalkieStatus } from "../calls/walkie";
// STATUS TRUTH AT THE SEAMS (pl-756, F5).
//
// The founder: "it just delays the status or gets on/off calls." Each seam
// below is one place where a call, a burst or a seat read as OFF for a moment
// and then ON again, or stayed on past its end, and each is pinned at the
// source it was fixed in: the engine, never a component's guess.
//
//   (b) hanging up frees the seat BEFORE the scribe's local teardown, so a
//       teammate's roster drops the face at End rather than after the flush;
//   (c) a seat re-taken after the server swept it keeps its walkie stamp, so a
//       conversation that survived a sleep is still a conversation;
//   (d) a LiveKit reconnect is still the call: the phase never dips, so the
//       desktop's in-huddle report and the seated room key hold;
//   (e) the walkie's own linger draws, so the surface never vanishes at Stop
//       and returns as a call when the far side's join lands;
//   (g) the join chime follows the ROSTER, so a prewarm peer (a connection
//       with no seat) arrives and leaves in silence.
//
// The convex half of (a), the heartbeat sweep, is pinned in
// apps/server/convex/calls.test.ts.

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { ConnectionState, DisconnectReason, RoomEvent } from "livekit-client";
import { useInboxStore } from "../../store/inboxStore";
import { flushSyncPublishes } from "../../store/syncTransaction";
import { RING_STUB_MS } from "../calls/ringStubs";
import {
  SCREEN_SHARE_CAPTURE,
  SCREEN_SHARE_PUBLISH,
} from "../calls/livekitMedia";

const restoreRoom = standInForLiveKitRoom();
afterAll(restoreRoom);

const sounds = await import("../sounds");
const transcription = await import("../calls/transcription");
const callManager = await import("../calls/callManager");
const { inHuddle } = await import("../calls/huddlePresence");
const { callDockSurface } = await import("../../hooks/useWalkie");

const soundLog: string[] = [];
let scribeStopping: { promise: Promise<void>; resolve: () => void } | null =
  null;
let scribeStops = 0;
let restores: Array<() => void> = [];
let web: Awaited<ReturnType<typeof mountWeb>>;
const backend = () => web.backend;
let since = 0;
let heartbeatAnswer: { ok: boolean } = { ok: true };
const token = {
  url: "wss://sfu.example",
  token: "tok",
} as FunctionReturnType<typeof api.calls.mintAccessToken>;

const named = (suffix: string) =>
  backend()
    .mutations.slice(since)
    .filter((c) => c.name === "calls:" + suffix)
    .map((c) => {
      if (
        !c.args ||
        typeof c.args !== "object" ||
        Array.isArray(c.args) ||
        c.args instanceof ArrayBuffer
      )
        throw new Error("Expected call arguments");
      return { ...c, args: c.args as Record<string, Value | undefined> };
    });
const forgetWrites = () => {
  since = backend().mutations.length;
};

const ROOM = "dm:me:them";
const S = () => useInboxStore.getState();

/** The occupancy feed landing, exactly as useCallSync hands it to the store,
 *  with the sync window's held publish delivered now rather than 33ms on: the
 *  seat watcher is a store subscriber, and this is the visit it gets. */
function occupancy(
  rows: Array<{ user_id: string; walkie_joined_at?: number }>,
) {
  S().syncTable("callOccupancy", {
    [ROOM]: rows.map((r) => ({ user_name: r.user_id, muted: true, ...r })),
  });
  flushSyncPublishes();
}

const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

beforeEach(async () => {
  const join = spyOn(sounds, "soundCallJoin").mockImplementation(
    () => void soundLog.push("join"),
  );
  const leave = spyOn(sounds, "soundCallLeave").mockImplementation(
    () => void soundLog.push("leave"),
  );
  const stop = spyOn(transcription, "stopScribe").mockImplementation(
    async () => {
      scribeStops++;
      if (scribeStopping) await scribeStopping.promise;
    },
  );
  restores = [
    () => join.mockRestore(),
    () => leave.mockRestore(),
    () => stop.mockRestore(),
  ];
  await mountCall();
});

async function mountCall(expectedConsoleErrors: readonly RegExp[] = []) {
  FakeRoom.made = [];
  FakeRoom.connectError = null;
  web = await mountWeb(null, {
    expectedConsoleErrors,
    setup(backend) {
      backend.mutation(api.calls.joinRoom, undefined);
      backend.mutation(api.calls.leaveRoom, undefined);
      backend.mutation(api.calls.cancelInvite, undefined);
      backend.mutation(api.calls.invite, undefined);
      backend.mutation(api.calls.respondInvite, undefined);
      backend.mutation(
        api.calls.heartbeat,
        () => heartbeatAnswer as FunctionReturnType<typeof api.calls.heartbeat>,
      );
      backend.action(api.calls.mintAccessToken, token);
      backend.set(api.calls.getRoomOccupancy, {});
    },
  });
  since = 0;
  soundLog.length = 0;
  heartbeatAnswer = { ok: true };
  scribeStopping = null;
  scribeStops = 0;
  S().setCallState({
    phase: "idle",
    roomKey: null,
    muted: true,
    error: null,
    speaking: [],
  });
  occupancy([]);
  callManager.bindConvex(backend().client);
}

afterEach(async () => {
  scribeStopping?.resolve();
  try {
    await callManager.leaveCall();
    await web.close();
  } finally {
    for (const restore of restores) restore();
  }
});

const room = () => FakeRoom.made[FakeRoom.made.length - 1];

// ── the ring is on the row from the press ───────────────────────────────────

describe("the ring out is on the row before the invite lands", () => {
  // The store outlives a test: a live stub from the last one is withdrawn
  // (an expired clock is how the engine withdraws one too).
  beforeEach(() => {
    const stale = (S().myCalls?.outgoing ?? [])
      .filter((r) => String(r._id).startsWith("stub:"))
      .map((r) => ({ ...r, until: 0 }));
    S().syncTable("myCalls", {
      incoming: [],
      outgoing: stale,
      membership: null,
    });
    flushSyncPublishes();
    expect(S().myCalls.outgoing).toEqual([]);
  });

  test("a stub ringing row stands in for the invite's round trip, then leaves", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    backend().mutation(api.calls.invite, async () => {
      await gate;
      return {
        results: [{ to_user: "them", busy: false, cooldown: false }],
      } as FunctionReturnType<typeof api.calls.invite>;
    });
    S().syncTable("myCalls", { incoming: [], outgoing: [], membership: null });
    const ringing = callManager.ringInto(ROOM, ["them"]);
    await settle();
    flushSyncPublishes();
    // MUTATION CHECK: drop the ringStubs(…, true) call in ringInto and this
    // reads an empty outgoing list while the mutation is in flight.
    expect(S().myCalls.outgoing).toMatchObject([
      { room_key: ROOM, to_user: "them", status: "ringing" },
    ]);
    expect(String(S().myCalls.outgoing[0]._id).startsWith("stub:")).toBe(true);
    // Cancel on a stub sends nothing: there is no invite to cancel yet.
    await callManager.cancelOutgoing(String(S().myCalls.outgoing[0]._id));
    expect(named("cancelInvite")).toHaveLength(0);
    release();
    await ringing;
    flushSyncPublishes();
    // Rung: the stub stands until the server's own list lands, a tick later.
    expect(S().myCalls.outgoing).toMatchObject([
      { to_user: "them", status: "ringing" },
    ]);
    S().syncTable("myCalls", {
      incoming: [],
      outgoing: [
        {
          _id: "i1",
          room_key: ROOM,
          to_user: "them",
          to_name: "Them",
          status: "ringing",
        },
      ],
      membership: null,
    });
    flushSyncPublishes();
    expect(S().myCalls.outgoing.map((r) => String(r._id))).toEqual(["i1"]);
  });

  test("a server push with no row for the person keeps the stub; one with the row replaces it; an old stub is dropped", async () => {
    backend().mutation(api.calls.invite, () => new Promise(() => {}));
    S().syncTable("myCalls", { incoming: [], outgoing: [], membership: null });
    void callManager.ringInto(ROOM, ["them"]);
    await settle();
    flushSyncPublishes();
    expect(S().myCalls.outgoing.map((r) => r.to_user)).toEqual(["them"]);
    // My own seat write re-pushes getMyCalls before the invite exists.
    S().syncTable("myCalls", {
      incoming: [],
      outgoing: [],
      membership: { room_key: ROOM },
    });
    flushSyncPublishes();
    // MUTATION CHECK: take the merge off the myCalls registry entry and this
    // reads an empty list: the stub was replaced a tick before the row.
    expect(S().myCalls.outgoing.map((r) => r.to_user)).toEqual(["them"]);
    expect(S().myCalls.membership).toEqual({ room_key: ROOM });
    // The server lists them: the stub is gone, the row stands alone.
    S().syncTable("myCalls", {
      incoming: [],
      outgoing: [
        {
          _id: "i1",
          room_key: ROOM,
          to_user: "them",
          to_name: "Them",
          status: "ringing",
        },
      ],
      membership: null,
    });
    flushSyncPublishes();
    expect(S().myCalls.outgoing.map((r) => String(r._id))).toEqual(["i1"]);
    // A stub past its clock never outlives a push.
    S().syncTable("myCalls", {
      incoming: [],
      outgoing: [
        {
          _id: "stub:x:y",
          room_key: "x",
          to_user: "y",
          to_name: "Y",
          status: "ringing",
          created_at: 0,
          until: 1,
        },
      ],
      membership: null,
    });
    flushSyncPublishes();
    expect(S().myCalls.outgoing).toEqual([]);
  });

  test("a person the server did not ring loses the stub when the answer comes", async () => {
    backend().mutation(api.calls.invite, {
      results: [
        { to_user: "them", busy: false, cooldown: true },
        { to_user: "other", busy: false, cooldown: false },
      ],
    } as FunctionReturnType<typeof api.calls.invite>);
    S().syncTable("myCalls", { incoming: [], outgoing: [], membership: null });
    await callManager.ringInto(ROOM, ["them", "other"]);
    flushSyncPublishes();
    expect(S().myCalls.outgoing.map((r) => r.to_user)).toEqual(["other"]);
  });

  test("startHuddle rings on the row before the join, not after it", async () => {
    let releaseToken!: () => void;
    const tokenGate = new Promise<void>((r) => (releaseToken = r));
    backend().action(api.calls.mintAccessToken, async () => {
      await tokenGate;
      return token;
    });
    S().syncTable("myCalls", { incoming: [], outgoing: [], membership: null });
    const started = callManager.startHuddle({
      roomKey: ROOM,
      toUserIds: ["them"],
    });
    await settle();
    flushSyncPublishes();
    // Still joining (the token has not come back), and the ring is already up.
    // MUTATION CHECK: move ringStubs(…, true) in startHuddleHere below the
    // join and this reads an empty outgoing list here.
    expect(S().call.phase).not.toBe("connected");
    expect(S().myCalls.outgoing).toMatchObject([
      { room_key: ROOM, to_user: "them", status: "ringing" },
    ]);
    releaseToken();
    await started;
    flushSyncPublishes();
    expect(S().call.phase).toBe("connected");
    expect(named("invite")).toHaveLength(1);
    // The harness answers the invite with no results: nobody rung, no stub left.
    expect(S().myCalls.outgoing).toEqual([]);
  });

  test("a re-stub after a slow join re-arms the stub's clock, so a push inside the invite's round trip keeps the ring", async () => {
    // The press stubs at once, and ringInto stubs again once the join lands.
    // A join can outlive the stub's clock (a permission prompt, a slow
    // handshake); the second stub must carry a fresh clock, or a seat push
    // landing during the invite's round trip drops the expired stub and the
    // face reads online, then ringing again when the row lands.
    const T0 = 1_700_000_000_000;
    let now = T0;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      let releaseToken!: () => void;
      const tokenGate = new Promise<void>((r) => (releaseToken = r));
      let releaseInvite!: () => void;
      const inviteGate = new Promise<void>((r) => (releaseInvite = r));
      backend().action(api.calls.mintAccessToken, async () => {
        await tokenGate;
        return token;
      });
      backend().mutation(api.calls.invite, async () => {
        await inviteGate;
        return {
          results: [{ to_user: "them", busy: false, cooldown: false }],
        } as FunctionReturnType<typeof api.calls.invite>;
      });
      S().syncTable("myCalls", {
        incoming: [],
        outgoing: [],
        membership: null,
      });
      const started = callManager.startHuddle({
        roomKey: ROOM,
        toUserIds: ["them"],
      });
      await settle();
      flushSyncPublishes();
      expect(S().myCalls.outgoing).toMatchObject([
        { to_user: "them", status: "ringing", until: T0 + RING_STUB_MS },
      ]);
      // The join lands 20s in, past the first clock, and the invite goes out.
      now = T0 + 20_000;
      releaseToken();
      // The join has a timer or two in it after the token; wait on the clock.
      for (let i = 0; i < 200 && named("invite").length === 0; i++)
        await new Promise((r) => setTimeout(r, 10));
      expect(named("invite")).toHaveLength(1);
      flushSyncPublishes();
      // MUTATION CHECK: skip the re-stub for a person the list already shows
      // ringing (stub included) and the clock stays at the press's.
      expect(S().myCalls.outgoing).toHaveLength(1);
      expect(S().myCalls.outgoing).toMatchObject([
        { to_user: "them", status: "ringing", until: now + RING_STUB_MS },
      ]);
      // A push with no row for them, inside the invite's round trip: the
      // stub stands, because its clock is live.
      S().syncTable("myCalls", {
        incoming: [],
        outgoing: [],
        membership: { room_key: ROOM },
      });
      flushSyncPublishes();
      expect(S().myCalls.outgoing.map((r) => r.to_user)).toEqual(["them"]);
      releaseInvite();
      await started;
    } finally {
      Date.now = realNow;
    }
  });

  test("a person the server already lists as ringing gets no second row", async () => {
    S().syncTable("myCalls", {
      incoming: [],
      outgoing: [
        {
          _id: "i1",
          room_key: ROOM,
          to_user: "them",
          to_name: "Them",
          status: "ringing",
        },
      ],
      membership: null,
    });
    await callManager.ringInto(ROOM, ["them"]);
    flushSyncPublishes();
    expect(S().myCalls.outgoing.map((r) => String(r._id))).toEqual(["i1"]);
  });
});

// ── the ring stops at the press ─────────────────────────────────────────────

describe("answering a ring stops it before the server answers", () => {
  const RING = {
    _id: "in1",
    room_key: ROOM,
    from_user: "them",
    from_name: "Them",
  };

  for (const [press, act] of [
    ["Join", () => callManager.acceptInvite("in1", ROOM)],
    ["Decline", () => callManager.declineInvite("in1")],
  ] as const) {
    test(`${press} takes the ring off the list at once and a stale push does not bring it back`, async () => {
      let answer!: () => void;
      const held = new Promise<void>((r) => (answer = r));
      backend().mutation(api.calls.respondInvite, async () => {
        await held;
        return undefined;
      });
      S().syncTable("myCalls", {
        incoming: [RING],
        outgoing: [],
        membership: null,
      });
      const done = act();
      // The respondInvite round trip is still out: the card and the ring
      // sound read this list, so it must already be empty.
      expect(S().myCalls.incoming).toEqual([]);
      // MUTATION CHECK: take the incoming merge off the myCalls registry
      // entry and the push that still names the invite rings again.
      S().syncTable("myCalls", {
        incoming: [RING],
        outgoing: [],
        membership: null,
      });
      expect(S().myCalls.incoming).toEqual([]);
      answer();
      await done;
      await settle();
    });
  }

  test("the check before answering holds the ring, and closing it lets the ring back", () => {
    S().syncTable("myCalls", {
      incoming: [RING],
      outgoing: [],
      membership: null,
    });
    callManager.holdRing("in1");
    expect(S().myCalls.incoming).toEqual([]);
    S().syncTable("myCalls", {
      incoming: [RING],
      outgoing: [],
      membership: null,
    });
    expect(S().myCalls.incoming).toEqual([]);
    callManager.releaseRing(RING);
    expect(S().myCalls.incoming.map((r) => r._id)).toEqual(["in1"]);
    S().syncTable("myCalls", {
      incoming: [RING],
      outgoing: [],
      membership: null,
    });
    expect(S().myCalls.incoming.map((r) => r._id)).toEqual(["in1"]);
  });

  test("another ring still rings", () => {
    S().syncTable("myCalls", {
      incoming: [{ ...RING, _id: "in2" }],
      outgoing: [],
      membership: null,
    });
    expect(S().myCalls.incoming.map((r) => r._id)).toEqual(["in2"]);
  });
});

// ── (d) a reconnect is still the call ───────────────────────────────────────

describe("a LiveKit reconnect is still the call", () => {
  test("the phase holds at connected through Reconnecting, and every reader of it holds too", async () => {
    await callManager.joinCall(ROOM, { intent: "deliberate" });
    expect(S().call.phase).toBe("connected");

    room().emit(RoomEvent.ConnectionStateChanged, ConnectionState.Reconnecting);

    // MUTATION CHECK: restore `setCall({ phase: "connecting" })` on
    // Reconnecting and all three of these flip, which is the off-then-on the
    // founder saw: the desktop says "not in a huddle", the knocks and the
    // auto-scribe watch lose their room, the dock paints "connecting".
    expect(S().call.phase).toBe("connected");
    expect(inHuddle(S())).toBe(true);
    const seatedRoomKey =
      S().call.phase === "connected" ? S().call.roomKey : null;
    expect(seatedRoomKey).toBe(ROOM);

    room().emit(RoomEvent.ConnectionStateChanged, ConnectionState.Connected);
    expect(S().call.phase).toBe("connected");
  });

  test("a heartbeat during the reconnect still re-takes a swept seat", async () => {
    // The recovery join is gated on `phase === "connected"`; a phase that
    // dipped to "connecting" for the reconnect would skip it and leave the
    // seat gone for good once the media came back.
    await callManager.joinCall(ROOM, { intent: "deliberate" });
    room().emit(RoomEvent.ConnectionStateChanged, ConnectionState.Reconnecting);
    forgetWrites();
    heartbeatAnswer = { ok: false };
    await callManager.heartbeatOnce(ROOM);
    expect(named("joinRoom")).toHaveLength(1);
  });
});

// ── (b) the seat goes before the scribe ─────────────────────────────────────

describe("hanging up frees the seat before the scribe's teardown", () => {
  test("leaveRoom is sent while stopScribe is still running", async () => {
    await callManager.joinCall(ROOM, { intent: "deliberate" });
    forgetWrites();
    let resolve!: () => void;
    scribeStopping = {
      promise: new Promise<void>((r) => {
        resolve = r;
      }),
      resolve: () => resolve(),
    };

    const leaving = callManager.leaveCall();
    await settle();

    // MUTATION CHECK: move the leaveRoom mutation back below `stopScribe` and
    // this reads 0: the seat survives the flush, so every teammate's roster
    // keeps our face for as long as our pipes take to close.
    expect(scribeStops).toBe(1);
    expect(named("leaveRoom")).toHaveLength(1);
    // End is a hang-up: the server stops a recording at once when the last
    // teammate hangs up, rather than holding it for a reload.
    expect(named("leaveRoom")[0].args).toEqual({
      room_key: ROOM,
      hangup: true,
    });
    // The call is over for the person while the flush still runs: the row
    // lets go on End, not seconds later when the pipes have closed.
    // MUTATION CHECK: move setCall({ phase: "idle" }) back below stopScribe
    // and this reads "connected".
    expect(S().call.phase).toBe("idle");
    expect(S().call.roomKey).toBeNull();

    scribeStopping.resolve();
    await leaving;
    expect(S().call.phase).toBe("idle");
  });

  test("a removal frees the seat without a hang-up", async () => {
    await callManager.joinCall(ROOM, { intent: "deliberate" });
    forgetWrites();
    // Nobody pressed End: the server gives a recording the time a reload
    // takes to come back, rather than stopping it as a hang-up would.
    room().emit(RoomEvent.Disconnected, DisconnectReason.PARTICIPANT_REMOVED);
    await settle();
    expect(named("leaveRoom").map((c) => c.args)).toEqual([{ room_key: ROOM }]);
  });
});

// ── a dropped connection joins the room again ───────────────────────────────

describe("the media dropping under a person who never pressed End", () => {
  const waitFor = async (ok: () => boolean) => {
    for (let i = 0; i < 2000 && !ok(); i++)
      await new Promise((r) => setTimeout(r, 0));
  };

  test("rejoins the same room with the seat, the phase and the mute intact", async () => {
    await callManager.joinCall(ROOM, { intent: "deliberate" });
    await callManager.setMuted(false, { remember: false });
    const first = room();
    forgetWrites();
    soundLog.length = 0;

    // The 2026-10-19 drop: LiveKit gave up, and the call used to end there.
    first.emit(RoomEvent.Disconnected, DisconnectReason.SIGNAL_CLOSE);
    expect(S().call.phase).toBe("connected");
    await waitFor(() => room() !== first && !S().call.reconnecting);

    // MUTATION CHECK: put `leaveCall(undefined, { hangup: false })` back in the
    // Disconnected handler and the seat goes: leaveRoom is sent, no new Room
    // is made and the phase reads idle.
    expect(named("leaveRoom")).toHaveLength(0);
    expect(room()).not.toBe(first);
    expect(room().state).toBe(ConnectionState.Connected);
    expect(named("joinRoom").map((c) => c.args.room_key)).toEqual([ROOM]);
    expect(S().call).toMatchObject({
      phase: "connected",
      roomKey: ROOM,
      muted: false,
      reconnecting: false,
    });
    // A rejoin is not an arrival: no join chime, no leave chime.
    expect(soundLog).toEqual([]);
  });

  test("keeps trying while the SFU is unreachable, and End stops it", async () => {
    await callManager.joinCall(ROOM, { intent: "deliberate" });
    const first = room();
    let mints = 0;
    FakeRoom.connectError = new Error("network");
    backend().action(api.calls.mintAccessToken, () => {
      mints++;
      return token;
    });
    forgetWrites();

    first.emit(RoomEvent.Disconnected);
    await waitFor(() => mints >= 2);
    expect(S().call).toMatchObject({
      phase: "connected",
      roomKey: ROOM,
      reconnecting: true,
    });
    // Each attempt re-takes the seat, so the lease never lapses under it.
    expect(named("joinRoom").length).toBeGreaterThanOrEqual(1);
    expect(named("leaveRoom")).toHaveLength(0);

    await callManager.leaveCall();
    const after = mints;
    await new Promise((r) => setTimeout(r, 2_500));
    expect(mints).toBe(after);
    expect(S().call).toMatchObject({
      phase: "idle",
      roomKey: null,
      reconnecting: false,
    });
  });

  test("a rejected access token leaves the seat in place and retries", async () => {
    await web.close();
    await mountCall([
      /\[CONVEX A\(calls:mintAccessToken\)\].*Token service unavailable/,
    ]);
    await callManager.joinCall(ROOM, { intent: "deliberate" });
    const first = room();
    const start = backend().actions.length;
    let attempts = 0;
    backend().action(api.calls.mintAccessToken, () =>
      ++attempts === 1 ? new Error("Token service unavailable") : token,
    );
    forgetWrites();

    first.emit(RoomEvent.Disconnected);
    await waitFor(() => room() !== first && !S().call.reconnecting);

    expect(backend().actions.slice(start)).toEqual([
      { name: "calls:mintAccessToken", args: { room_key: ROOM } },
      { name: "calls:mintAccessToken", args: { room_key: ROOM } },
    ]);
    expect(named("leaveRoom")).toEqual([]);
    expect(named("joinRoom").map(({ args }) => args.room_key)).toEqual([
      ROOM,
      ROOM,
    ]);
    expect(room()).not.toBe(first);
    expect(room().state).toBe(ConnectionState.Connected);
    expect(S().call).toMatchObject({
      phase: "connected",
      roomKey: ROOM,
      reconnecting: false,
    });
  });

  test("a handoff to another window of mine is still not a rejoin", async () => {
    await callManager.joinCall(ROOM, { intent: "deliberate" });
    const first = room();
    forgetWrites();
    first.emit(RoomEvent.Disconnected, DisconnectReason.DUPLICATE_IDENTITY);
    await settle();
    expect(room()).toBe(first);
    expect(named("joinRoom")).toHaveLength(0);
    expect(named("leaveRoom")).toHaveLength(0);
    expect(S().call.phase).toBe("idle");
  });

  test("LiveKit's own retries show as reconnecting without leaving the call", async () => {
    await callManager.joinCall(ROOM, { intent: "deliberate" });
    room().emit(RoomEvent.ConnectionStateChanged, ConnectionState.Reconnecting);
    expect(S().call).toMatchObject({ phase: "connected", reconnecting: true });
    room().emit(RoomEvent.ConnectionStateChanged, ConnectionState.Connected);
    expect(S().call).toMatchObject({ phase: "connected", reconnecting: false });
  });
});

// ── (c) the re-taken seat keeps its stamp ───────────────────────────────────

describe("a seat re-taken after a sweep keeps its walkie stamp", () => {
  test("the recovery join re-sends walkie_join for a seat that was stamped", async () => {
    await callManager.joinCall(ROOM, {
      intent: "deliberate",
      walkieJoin: true,
    });
    expect(named("joinRoom")[0].args.walkie_join).toBe(true);
    forgetWrites();

    heartbeatAnswer = { ok: false };
    await callManager.heartbeatOnce(ROOM);

    // MUTATION CHECK: drop `walkieJoinedSeat` from controlJoin and the
    // re-take lands unstamped: to every third party the conversation reads
    // as a burst that ended, and the far side's surface falls back to the
    // strip.
    const retake = named("joinRoom");
    expect(retake).toHaveLength(1);
    expect(retake[0].args.walkie_join).toBe(true);
  });

  test("a seat that was never stamped is re-taken unstamped", async () => {
    // The stamp is intent, recorded rather than inferred: a recovery must
    // not invent one for an auto-listen seat.
    await callManager.joinCall(ROOM, { intent: "listen" });
    expect(named("joinRoom")[0].args.walkie_join).toBeUndefined();
    forgetWrites();
    heartbeatAnswer = { ok: false };
    await callManager.heartbeatOnce(ROOM);
    expect(named("joinRoom")[0].args.walkie_join).toBeUndefined();
  });

  test("the stamp ends with the seat: the next join into the same room starts clean", async () => {
    await callManager.joinCall(ROOM, {
      intent: "deliberate",
      walkieJoin: true,
    });
    await callManager.leaveCall();
    forgetWrites();
    await callManager.joinCall(ROOM, { intent: "listen" });
    expect(named("joinRoom")[0].args.walkie_join).toBeUndefined();
  });
});

// ── (g) the chime follows the roster ────────────────────────────────────────

describe("the join chime follows the roster, not the SFU", () => {
  const peer = (identity: string) => ({
    identity,
    name: identity,
    metadata: undefined,
    getTrackPublication: () => undefined,
    trackPublications: new Map(),
  });

  test("a peer whose seat already landed chimes at once", async () => {
    await callManager.joinCall(ROOM, { intent: "deliberate" });
    soundLog.length = 0;
    occupancy([{ user_id: "me" }, { user_id: "them" }]);
    room().emit(RoomEvent.ParticipantConnected, peer("them"));
    expect(soundLog).toEqual(["join"]);
  });

  test("a peer whose media beats their row chimes when the row lands, once", async () => {
    await callManager.joinCall(ROOM, { intent: "deliberate" });
    soundLog.length = 0;
    room().emit(RoomEvent.ParticipantConnected, peer("them"));
    expect(soundLog).toEqual([]);
    occupancy([{ user_id: "me" }, { user_id: "them" }]);
    expect(soundLog).toEqual(["join"]);
    // A later roster push for the same seat is not a second arrival.
    occupancy([{ user_id: "me" }, { user_id: "them", walkie_joined_at: 1 }]);
    expect(soundLog).toEqual(["join"]);
  });

  test("a prewarm peer arrives and leaves in silence", async () => {
    // MUTATION CHECK: chime on ParticipantConnected unconditionally and the
    // first expectation reads ["join"]: a teammate who opened this DM, or
    // rested on a face, is announced as having walked in.
    await callManager.joinCall(ROOM, { intent: "deliberate" });
    soundLog.length = 0;
    room().emit(RoomEvent.ParticipantConnected, peer("hoverer"));
    // Some other roster movement meanwhile must not be read as their seat.
    occupancy([{ user_id: "me" }, { user_id: "them" }]);
    room().emit(RoomEvent.ParticipantDisconnected, peer("hoverer"));
    expect(soundLog).toEqual([]);
  });

  test("a seated peer leaving still chimes out", async () => {
    await callManager.joinCall(ROOM, { intent: "deliberate" });
    occupancy([{ user_id: "me" }, { user_id: "them" }]);
    soundLog.length = 0;
    room().emit(RoomEvent.ParticipantConnected, peer("them"));
    room().emit(RoomEvent.ParticipantDisconnected, peer("them"));
    expect(soundLog).toEqual(["join", "leave"]);
  });
});

// ── (e) the linger draws ────────────────────────────────────────────────────

describe("the walkie's own linger is drawn, not hidden", () => {
  const status = (over: Partial<WalkieStatus>): WalkieStatus => ({
    sending: null,
    incoming: null,
    liveRoom: null,
    unavailable: null,
    canReply: false,
    asr: "live",
    error: null,
    ...over,
  });

  test("my seat lingering after Stop is still the walkie's surface", () => {
    // MUTATION CHECK: restore the `return "none"` for a quiet own seat and
    // the first expectation reads "none": the surface vanishes at Stop and
    // returns as a call when the far side's join lands, off then on.
    const linger = status({ liveRoom: { key: ROOM, mode: "burst", since: 1 } });
    const seated = { roomKey: ROOM, phase: "connected" };
    expect(callDockSurface(linger, seated, { expanded: false })).toBe("walkie");
    expect(callDockSurface(linger, seated, { expanded: true })).toBe("walkie");
    // Once the seat is released nothing is held, and nothing draws.
    expect(
      callDockSurface(
        status({}),
        { roomKey: null, phase: "idle" },
        { expanded: false },
      ),
    ).toBe("none");
  });
});

test("starting a screen share passes capture and publish settings to LiveKit", async () => {
  await callManager.joinCall(ROOM);
  try {
    await callManager.setScreenShare(true);
    const participant = FakeRoom.made[0].localParticipant;
    expect(participant.setScreenShareEnabled.mock.calls).toEqual([
      [true, SCREEN_SHARE_CAPTURE, SCREEN_SHARE_PUBLISH],
    ]);
  } finally {
    await callManager.leaveCall();
  }
});
