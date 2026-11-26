import { useWatchEffect } from "../useWatchEffect";
import { afterEach, expect, test } from "bun:test";
import {
  CALL_HEARTBEAT_MS,
  CALL_MEMBER_STALE_MS,
} from "@codecast/calls/callRoomKeys";
import { act } from "react";
import { mountWeb } from "../../test-helpers/mountWeb";
import { FIXTURE_TEAM, withTeamRoster } from "../../test-helpers/teamRoster";
import { stampRoster } from "../../lib/activeTeam";
import { useInboxStore } from "../../store/inboxStore";
import {
  announceJoin,
  clearJoinAnnouncement,
  JOIN_TITLE_MS,
} from "../../lib/calls/joinAnnounce";
import {
  FACE_ROW_TICK_MS,
  fakeFaceRowInput,
  resetFaceRow,
  type FaceRow,
} from "../../lib/faces/face-row";
import { burstRoom, sendingTo } from "../../lib/faces/faceRowFixtures";
import { useFaceRow } from "../useFaceRow";

// THE ROW'S WAKE DISCIPLINE (pl-756 F1). The header bar is mounted for the
// life of the app and the roster re-pushes every few seconds on heartbeat
// counters, so the hook must render its caller only when a face changed:
// once for the store write that moves a face, once for a join announcement,
// and never for a push that changed nothing a face draws.

const ME = "u-me";
const ANN = "u-ann";
const ROOM = `dm:${ANN}:${ME}`;
const member = (
  id: string,
  name: string,
  over: Record<string, unknown> = {},
) => ({ _id: id, name, presence_state: "active", ...over });

let renders = 0;
let latest: FaceRow;
function Probe() {
  renders++;
  const row = useFaceRow();
  useWatchEffect(() => {
    latest = row;
  });
  return null;
}

let mounted: Awaited<ReturnType<typeof mountWeb>> | undefined;
afterEach(async () => {
  await mounted?.close();
  mounted = undefined;
  clearJoinAnnouncement();
  resetFaceRow();
});
async function mount(setup?: () => void) {
  renders = 0;
  resetFaceRow();
  mounted = await mountWeb(<Probe />, {
    clock: true,
    setup: (_backend, store) => {
      useInboxStore.setState({
        currentUser: { _id: ME, name: "Me" },
        ...withTeamRoster([member(ME, "Me"), member(ANN, "Ann")], {
          clientState: store.clientState,
        }),
        callOccupancy: {},
        liveRooms: [],
        myCalls: { incoming: [], outgoing: [], membership: null },
        followLeaderId: null,
        call: { ...store.call, phase: "idle", roomKey: null, muted: true },
      } as any);
      setup?.();
    },
  });
  return mounted.clock!;
}

function connect(joinedAt?: number) {
  useInboxStore.setState({
    call: {
      ...useInboxStore.getState().call,
      phase: "connected",
      roomKey: ROOM,
      muted: false,
    },
    callOccupancy: {
      [ROOM]: [{ user_id: ME }, { user_id: ANN, walkie_joined_at: joinedAt }],
    },
  } as any);
}

test("a heartbeat only roster push renders nobody; a face change renders once", async () => {
  await mount();
  const first = latest;
  expect(first.entries.map((e) => e.id)).toEqual([ANN]);
  const mounted = renders;

  await act(async () => {
    useInboxStore.setState({
      teamMembers: stampRoster(
        [
          member(ME, "Me"),
          member(ANN, "Ann", {
            presence_input_at: Date.now(),
            daemon_last_seen: Date.now(),
          }),
        ],
        FIXTURE_TEAM,
      ),
    } as any);
  });
  expect(renders).toBe(mounted);
  expect(latest).toBe(first);

  await act(async () => {
    useInboxStore.setState({ followLeaderId: ANN } as any);
  });
  expect(renders).toBe(mounted + 1);
  expect(latest.entries[0]).toMatchObject({ id: ANN, followed: true });
});

test("a join announcement wakes the row through its own subscription", async () => {
  const clock = await mount(() => connect());
  expect(latest.card.kind).toBe("live");
  const mounted = renders;
  await act(async () => {
    announceJoin(ROOM, "Ann joined");
  });
  expect(renders).toBe(mounted + 1);
  expect(latest.card).toMatchObject({
    kind: "joined-notice",
    text: "Ann joined",
  });
  expect(latest.entries.map((e) => e.state)).toEqual(["in-call", "joining"]);
  await clock.advance(JOIN_TITLE_MS);
  expect(renders).toBe(mounted + 2);
  expect(latest.card.kind).toBe("live");
});

test("an idle face row does not render on a clock tick", async () => {
  const clock = await mount();
  expect(latest.entries.map((e) => e.id)).toEqual([ANN]);
  const before = renders;
  await clock.advance(FACE_ROW_TICK_MS);
  expect(renders - before).toBe(0);
});

test("a face row with a joined age renders once on a clock tick", async () => {
  const clock = await mount(() => connect(Date.now() - 1_000));
  const before = renders;
  const joinedAgo = () =>
    latest.entries.find((entry) => entry.id === ANN)?.joinedAgo;
  expect(joinedAgo()).toBe(1_000);
  await clock.advance(FACE_ROW_TICK_MS);
  expect(renders - before).toBe(1);
  expect(joinedAgo()).toBe(16_000);
});

test("a snooze expiry renders once and later ticks keep the row", async () => {
  const clock = await mount(() => {
    useInboxStore.setState({
      teamMembers: stampRoster(
        [
          member(ME, "Me"),
          member(ANN, "Ann", {
            walkie_snoozed_until: Date.now() + FACE_ROW_TICK_MS,
          }),
        ],
        FIXTURE_TEAM,
      ),
    } as any);
    fakeFaceRowInput({
      walkie: {
        liveRoom: burstRoom(ROOM),
        sending: {
          ...sendingTo(ROOM),
          channelId: "dm-ann",
          clientId: "burst-1",
          messageId: null,
          startedAt: Date.now(),
          openAt: Date.now(),
          transcript: "",
        },
      },
    });
  });
  expect(latest.card).toMatchObject({
    kind: "live",
    hearing: { state: "busy" },
  });
  const before = renders;
  await clock.advance(FACE_ROW_TICK_MS);
  expect(latest.card).toMatchObject({
    kind: "live",
    hearing: { state: "away" },
  });
  await clock.advance(FACE_ROW_TICK_MS);
  expect(renders - before).toBe(1);
});

test("a hang-up hold keeps a stale ring hidden until it expires", async () => {
  const clock = await mount(() => {
    useInboxStore.setState({
      call: {
        ...useInboxStore.getState().call,
        left: { roomKey: ROOM, at: Date.now() },
      },
      myCalls: {
        incoming: [],
        outgoing: [{ room_key: ROOM, to_user: ANN, status: "ringing" }],
        membership: null,
      },
    } as any);
  });
  expect(latest.card.kind).toBe("none");
  const before = renders;
  const holdMs = CALL_MEMBER_STALE_MS + CALL_HEARTBEAT_MS;
  await clock.advance(holdMs - FACE_ROW_TICK_MS);
  expect(renders - before).toBe(0);
  await clock.advance(FACE_ROW_TICK_MS);
  expect(renders - before).toBe(1);
  expect(latest.card.kind).toBe("ring-out");
});
