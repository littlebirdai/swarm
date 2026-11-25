import { describe, expect, test } from "bun:test";
import type { CallRoomFlags, LiveRoom } from "../../store/callRoomTypes";
import { webBuilders } from "../../test-helpers/builders";
import { expectAbsent, expectPresent } from "../../test-helpers/domExpect";
import { expectEmptyMount } from "../../test-helpers/expectEmptyMount";
import { mountWeb } from "../../test-helpers/mountWeb";
import { withTeamRoster } from "../../test-helpers/teamRoster";
import { LiveNowRail } from "../calls/LiveNow";

const { teamMember } = webBuilders("liveNowRail.test.tsx");
const me = teamMember.build();
const ann = teamMember.build({ name: "Ann" });
const roster = withTeamRoster([me, ann]);
const roomKey = "dm:" + [ann._id, me._id].sort().join(":");
const room: LiveRoom = {
  room_key: roomKey,
  team_id: "fixture-team",
  can_join: true,
  redacted: false,
  members: [{ user_id: ann._id, user_name: ann.name }],
};
const locked: CallRoomFlags = {
  _id: roomKey,
  locked: true,
  transcribe_off: false,
  transcribe_off_at: null,
};

function rail(
  isNarrow: boolean,
  state: { empty?: boolean; locked?: boolean; mine?: boolean } = {},
) {
  return mountWeb(<LiveNowRail isNarrow={isNarrow} />, {
    setup(_backend, store) {
      store.syncTable("currentUser", me);
      store.syncTable("clientState", roster.clientState);
      store.syncTable("teamMembers", roster.teamMembers);
      store.syncTable(
        "liveRooms",
        state.empty ? [] : [{ ...room, can_join: !state.locked }],
      );
      store.syncTable("guestsWaiting", [
        {
          guest_id: "expired-guest",
          name: "Expired guest",
          room_key: roomKey,
          title: null,
          knocked_at: Date.now() - 60_000,
          present_until: Date.now() - 1,
        },
      ]);
      if (state.locked) store.syncTable("callRooms", [locked]);
      if (state.mine) store.setCallState({ roomKey, phase: "connected" });
    },
  });
}

describe("LiveNowRail", () => {
  test("an empty rail renders nothing when no room is occupied and the guest's lease has ended", async () => {
    const wide = await rail(false, { empty: true });
    expectEmptyMount(wide.container);
    await wide.close();
    const narrow = await rail(true, { empty: true });
    expectEmptyMount(narrow.container);
  });

  test("the icon rail offers a button for a room you may enter", async () => {
    const { container } = await rail(true);
    expectPresent(container.querySelector('button[aria-label="Join Ann"]'));
  });

  test("the icon rail offers a knock where the lock shuts you out", async () => {
    const { container } = await rail(true, { locked: true });
    expectPresent(container.querySelector('button[aria-label="Knock at Ann"]'));
    expectAbsent(container.querySelector('button[aria-label="Join Ann"]'));
  });

  test("the room you are sitting in offers its existing huddle window", async () => {
    const { container } = await rail(true, { mine: true });
    const button = container.querySelector('button[aria-label="Show Ann"]');
    expectPresent(button);
    expect(button.getAttribute("title")).toBe("Ann — show huddle");
  });

  test("the wide row carries no role of its own and its Join button names the room", async () => {
    const { container } = await rail(false);
    expectAbsent(container.querySelector('[role="button"]'));
    expectPresent(container.querySelector('button[aria-label="Join Ann"]'));
  });

  test("the live dot is decoration", async () => {
    const { container } = await rail(false);
    const dot = container.querySelector(".animate-ping")?.parentElement ?? null;
    expectPresent(dot);
    expect(dot.getAttribute("aria-hidden")).toBe("true");
  });
});
