import { expectAbsent, expectPresent } from "../../test-helpers/domExpect";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { act } from "react";
import { usePathname } from "next/navigation";
import { webBuilders } from "../../test-helpers/builders";
import { mountWeb } from "../../test-helpers/mountWeb";
import { pending } from "../../test-helpers/testConvex";
import type { WalkieStatus } from "../../lib/calls/walkie";
import { stampRoster } from "../../lib/activeTeam";
import { BAR_FACES } from "../../lib/faces/layout";
import {
  closeCallStage,
  getCallStageOpen,
  takeCallThreadRequest,
} from "../../lib/calls/callStage";
import {
  getDesktopWindowRole,
  installWindowRoleTracker,
} from "../../lib/desktop";
import type {
  FaceCard,
  FaceEntry,
  FaceRow as FaceRowModel,
  Link,
} from "../../lib/faces/face-row";
import { teamBarSig } from "../presence/memberPresence";
import { walkieFacesSig } from "../presence/useFaceKey";

const fixtures = webBuilders("teamBarFace.test.tsx");
const members = ["Me", "Ann", "Bo"].map((name) =>
  fixtures.teamMember.build({
    name,
    presence_state: "active",
    github_username: name.toLowerCase(),
  }),
);
const [ME, ANN, BO] = members.map((m) => m._id);
const TEAM = "k97b3xkt3wvhmc3p03dgwxtfr583m6bg";
const ROOM = `dm:${[ME, ANN].sort().join(":")}`;
const realFaceRowHooks = { ...(await import("../../hooks/useFaceRow")) };
let fakeRow: FaceRowModel;
mock.module("../../hooks/useFaceRow", () => ({
  ...realFaceRowHooks,
  useFaceRow: () => fakeRow,
}));
afterAll(() => mock.module("../../hooks/useFaceRow", () => realFaceRowHooks));

const { TeamAvatarBar } = await import("../TeamAvatarBar");

function entry(
  id: string,
  name: string,
  over: Partial<FaceEntry> = {},
): FaceEntry {
  return {
    id,
    name,
    image: undefined,
    me: false,
    tier: "online",
    state: "online",
    level: null,
    video: null,
    muted: false,
    followed: false,
    joinedAgo: null,
    unread: 0,
    ...over,
  };
}
function me(over: Partial<FaceEntry> = {}): FaceEntry {
  return entry(ME, "Me", { me: true, tier: "me", state: "in-call", ...over });
}
function rowOf(
  entries: FaceEntry[],
  links: Link[] = [],
  card: FaceCard = { kind: "none" },
): FaceRowModel {
  const mine = entries.find((e) => e.me) ?? null;
  return {
    entries,
    links,
    card,
    me: mine,
    room: mine ? ROOM : null,
  };
}
const link = (to: string, kind: Link["kind"]): Link => ({ from: ME, to, kind });
const liveCard: Extract<FaceCard, { kind: "live" }> = {
  kind: "live",
  roomKey: ROOM,
  title: "Ann",
  end: true,
  mute: true,
  muted: false,
  words: null,
  hearing: null,
  camera: false,
  cameraOn: false,
  private: false,
};

beforeEach(() => {
  fakeRow = rowOf([entry(ANN, "Ann"), entry(BO, "Bo")]);
});

let restoreRole: (() => void) | undefined;
afterEach(async () => {
  await act(async () => restoreRole?.());
  restoreRole = undefined;
});

function Location() {
  return (
    <span hidden data-route>
      {usePathname()}
    </span>
  );
}

async function mount(roster = members, floated = false, callRoom?: string) {
  const docks: string[] = [];
  const node = () => (
    <>
      <Location />
      <TeamAvatarBar />
    </>
  );
  const { backend, container, dom, navigationLog, rerender } = await mountWeb(
    node(),
    {
      setup: (backend, store) => {
        if (floated) {
          const before = getDesktopWindowRole();
          const electron: Partial<
            NonNullable<Window["__CODECAST_ELECTRON__"]>
          > = {
            openFacesWindow: async () => {
              docks.push("open");
            },
            closeFacesWindow: async () => {
              docks.push("close");
            },
            onWindowRole: (push) => {
              push({ ...before, facesOverlay: true });
              restoreRole = () => push(before);
            },
          };
          Object.defineProperty(window, "__CODECAST_ELECTRON__", {
            value: electron,
          });
          installWindowRoleTracker();
        }
        store.syncTable("currentUser", members[0]);
        store.syncTable("clientState", { ui: { active_team_id: TEAM } });
        store.syncTable("teams", [{ _id: TEAM, features: { calls: true } }]);
        store.syncTable("callConfig", { enabled: true });
        if (callRoom) store.setCallState({ roomKey: callRoom });
        store.syncTable("teamMembers", stampRoster(roster, TEAM));
        backend.set(api.teams.getTeamMembers, roster);
        backend.set(api.callChat.list, []);
        backend.set(api.chat.listMessages, pending);
      },
    },
  );
  const fire = async (el: Element, type: string) => {
    await act(async () => {
      el.dispatchEvent(
        new dom.window.MouseEvent(type, { bubbles: true, cancelable: true }),
      );
    });
  };
  return {
    backend,
    docks,
    navigationLog,
    draw: async (row: FaceRowModel) => {
      fakeRow = row;
      await rerender(node());
    },
    q: <T extends Element = HTMLElement>(sel: string) =>
      container.querySelector<T>(sel),
    all: (sel: string) =>
      Array.from(container.querySelectorAll<HTMLElement>(sel)),
    seat: (id: string) =>
      container.querySelector<HTMLElement>(`[data-face-id="${id}"]`)!,
    face: (id: string) =>
      container.querySelector<HTMLElement>(`[data-face-id="${id}"] .face`)!,
    fire,
  };
}

describe("the header draws the model's row", () => {
  test("one seat per entry, in the model's order, with me at the head and the link before the face", async () => {
    fakeRow = rowOf(
      [
        me({ state: "speaking", level: "mic" }),
        entry(ANN, "Ann", { tier: "linked", state: "hearing-me" }),
        entry(BO, "Bo"),
      ],
      [link(ANN, "tx")],
    );
    const h = await mount();
    expect(h.all("[data-face-id]").map((el) => el.dataset.faceId)).toEqual([
      ME,
      ANN,
      BO,
    ]);
    expect(h.face(ANN).getAttribute("data-state")).toBe("hearing-me");
    expect(h.q(".face-link")?.getAttribute("data-link-kind")).toBe("tx");
    // The bar says something is live, for the styles that hide it otherwise.
    expect(h.q(".people-bar")?.getAttribute("data-live")).toBe("1");
  });

  test("the card hangs under the row, and the door to the stage stands beside it only while a call is up", async () => {
    const h = await mount();
    expectAbsent(h.q(".engagement-card"));
    expectAbsent(h.q("[data-open-call]"));
    await h.draw(
      rowOf(
        [me(), entry(ANN, "Ann", { tier: "linked", state: "live-with-me" })],
        [link(ANN, "call")],
        liveCard,
      ),
    );
    const card = h.q(".engagement-card")!;
    expect(card.getAttribute("data-density")).toBe("bar");
    expectPresent(card.closest(".face-row"));
    expectPresent(h.q("[data-open-call]"));
    // A listen offers the card's answers, not the stage.
    await h.draw(
      rowOf(
        [me(), entry(ANN, "Ann", { tier: "linked", state: "talking-to-me" })],
        [link(ANN, "rx")],
        {
          kind: "incoming",
          roomKey: "dm:u-ann:u-me",
          from: ANN,
          name: "Ann",
          reply: true,
          join: true,
          snooze: true,
          words: {
            stage: "incoming",
            badge: "INCOMING",
            hint: "Ann is talking to you.",
          },
        },
      ),
    );
    expectPresent(h.q(".engagement-card"));
    expectAbsent(h.q("[data-open-call]"));
    // My own burst is a voice, not a call: the card, and no stage.
    await h.draw(
      rowOf(
        [
          me({ state: "speaking", level: "mic" }),
          entry(ANN, "Ann", { tier: "linked", state: "hearing-me" }),
        ],
        [link(ANN, "tx")],
        { ...liveCard, mute: false },
      ),
    );
    expectPresent(h.q(".engagement-card"));
    expectAbsent(h.q("[data-open-call]"));
  });

  test("Expand opens the stage in a browser, and nothing opens it on its own", async () => {
    fakeRow = rowOf(
      [me(), entry(ANN, "Ann", { tier: "linked", state: "live-with-me" })],
      [link(ANN, "call")],
      liveCard,
    );
    const h = await mount();
    expect(getCallStageOpen()).toBe(false);
    await h.fire(h.q("[data-open-call]")!, "click");
    expect(getCallStageOpen()).toBe(true);
  });

  test("the door wears the count of what was typed in the call's chat", async () => {
    fakeRow = rowOf(
      [me(), entry(ANN, "Ann", { tier: "linked", state: "live-with-me" })],
      [link(ANN, "call")],
      liveCard,
    );
    const h = await mount(members, false, ROOM);
    expect(h.q("[data-open-call]")!.textContent).toBe("");
    expect(h.q("[data-open-call]")!.getAttribute("aria-label")).toBe(
      "Expand the call",
    );
    await act(async () => {
      h.backend.set(
        api.callChat.list,
        [1, 2, 3].map((at) => ({
          _id: `arrival-${at}` as Id<"call_chat_messages">,
          user_id: ANN,
          user_name: "Ann",
          user_image: undefined,
          text: "A new line",
          attachments: undefined,
          at,
          mine: false,
          transcript_id: null,
          agent: null,
          event: null,
          event_reason: null,
          event_guest_name: null,
          event_run_id: null,
          event_span: null,
        })),
      );
    });
    expect(h.q("[data-open-call]")!.textContent).toBe("3");
    expect(h.q("[data-open-call]")!.getAttribute("aria-label")).toBe(
      "Expand the call, 3 new in its chat",
    );
    // The count is why they clicked: the stage opens on its thread.
    await h.fire(h.q("[data-open-call]")!, "click");
    expect(takeCallThreadRequest()).toBe(true);
    await act(async () => closeCallStage());
  });

  test("the header caps the row and counts the rest; me and the linked faces are never cut", async () => {
    const crowd = Array.from({ length: BAR_FACES + 3 }, (_, i) =>
      entry(`u-${i}`, `Person ${i}`),
    );
    fakeRow = rowOf(
      [
        me(),
        entry(ANN, "Ann", { tier: "linked", state: "live-with-me" }),
        ...crowd,
      ],
      [link(ANN, "call")],
      liveCard,
    );
    const h = await mount();
    const ids = h.all("[data-face-id]").map((el) => el.dataset.faceId);
    expect(ids.length).toBe(BAR_FACES);
    expect(ids.slice(0, 2)).toEqual([ME, ANN]);
    expect(h.q("[data-overflow]")?.textContent).toBe(
      `+${crowd.length + 2 - BAR_FACES}`,
    );
  });

  test("the row is people only, the count in their rhythm", async () => {
    // The count keeps the row's own gap (the bar's 4px and 2px of its own is
    // the 6px between faces). Starting a huddle lives in New, popping the row
    // out in the palette: no control sits after the roster.
    const crowd = Array.from({ length: BAR_FACES + 3 }, (_, i) =>
      entry(`u-${i}`, `Person ${i}`),
    );
    fakeRow = rowOf(
      [
        me(),
        entry(ANN, "Ann", { tier: "linked", state: "live-with-me" }),
        ...crowd,
      ],
      [link(ANN, "call")],
      liveCard,
    );
    const h = await mount();
    expect(h.q("[data-overflow]")?.className.split(" ")).toContain("ml-0.5");
    expect(h.all(".people-bar > button:not([data-overflow])").length).toBe(0);
    // The door to the stage is not a header control: it rides the call's card.
    expectPresent(h.q(".engagement-card [data-open-call]"));
  });

  test("with nobody on the roster the bar is only its feeder", async () => {
    const h = await mount([]);
    expectAbsent(h.q(".people-bar"));
  });
});

// ── the chrome around the row ───────────────────────────────────────────────

describe("the one card under a face", () => {
  test("opens after a dwell on a face: the person, what they are doing, the profile door, the reply box and the call actions, and no second photo", async () => {
    const h = await mount();
    await h.fire(h.face(ANN), "mouseover");
    expectAbsent(h.q("[data-member-card]"));
    await act(async () => {
      await Bun.sleep(180);
    });
    const card = h.q("[data-member-card]")!;
    expectPresent(card);
    // Inside the row, under the face's own seat band.
    expectPresent(card.closest(".face-row"));
    expect(card.textContent).toContain("Ann");
    // The face on the row is the picture; the card never repeats it.
    expectAbsent(card.querySelector("img"));
    // Talk and a huddle under the reply box: what you can do, on the card.
    expect(
      h.all("[data-member-card] .face-action-word").map((w) => w.textContent),
    ).toEqual(["Talk", "Huddle"]);
    expectPresent(card.querySelector(".fc-reply input"));
    // The profile door.
    await h.fire(card.querySelector("[data-door]")!, "click");
    expect(h.q("[data-route]")?.textContent).toBe("/org/@ann");
    expect(h.navigationLog.at(-1)).toEqual({
      path: "/org/@ann",
      action: "push",
    });
    expectAbsent(h.q("[data-member-card]"));
  });

  test("a click pins the same card; there is never a second popup under a face", async () => {
    const h = await mount();
    await h.fire(h.face(ANN), "mouseover");
    await act(async () => {
      await Bun.sleep(180);
    });
    expect(h.all("[data-member-card]").length).toBe(1);
    await h.fire(h.face(ANN), "click");
    expect(h.all("[data-member-card]").length).toBe(1);
    expectAbsent(h.q(".people-face-actions"));
    expect(h.face(ANN).getAttribute("aria-expanded")).toBe("true");
    // Pinned: the pointer leaving does not drop it.
    await h.fire(h.seat(ANN), "mouseout");
    await act(async () => {
      await Bun.sleep(260);
    });
    expectPresent(h.q("[data-member-card]"));
  });

  test("a hovered card lets go when the pointer leaves, and switches faces at once", async () => {
    const h = await mount();
    await h.fire(h.face(ANN), "mouseover");
    await act(async () => {
      await Bun.sleep(180);
    });
    expect(h.q("[data-member-card]")!.textContent).toContain("Ann");
    await h.fire(h.seat(ANN), "mouseout");
    await h.fire(h.seat(BO), "mouseover");
    expect(h.q("[data-member-card]")!.textContent).toContain("Bo");
    await h.fire(h.seat(BO), "mouseout");
    await act(async () => {
      await Bun.sleep(260);
    });
    expectAbsent(h.q("[data-member-card]"));
  });
});

describe("the context menu", () => {
  test("opens on a face with the person's name and the profile door", async () => {
    const h = await mount();
    await h.fire(h.face(BO), "contextmenu");
    const menu = document.querySelector('[role="menu"]')!;
    expectPresent(menu);
    expect(menu.textContent).toContain("Bo");
    expect(menu.textContent).toContain("Open profile");
    const profile = Array.from(menu.querySelectorAll('[role="menuitem"]')).find(
      (item) => item.textContent === "Open profile",
    );
    expect(profile?.textContent).toBe("Open profile");
    await h.fire(profile!, "click");
    expect(h.navigationLog.at(-1)).toEqual({
      path: "/org/@bo",
      action: "push",
    });
  });
});

describe("the pop out", () => {
  test("while the faces float the header keeps one chip, which docks them", async () => {
    const h = await mount(members, true);
    expectAbsent(h.q("[data-face-id]"));
    const chip = h.q("[data-dock-faces]")!;
    // It says what a click does, in the float's own verb.
    expect(chip.textContent).toContain("Dock faces");
    await h.fire(chip, "click");
    expect(h.docks).toEqual(["close"]);
  });
});

// ── wake discipline ─────────────────────────────────────────────────────────

describe("the bar wakes on what it draws", () => {
  const roster = (over: Record<string, string | number | boolean> = {}) => ({
    _id: "u_ann",
    name: "Ann Diaz",
    image: "a.png",
    presence_state: "active",
    presence_input_at: 1_700_000_000_000,
    ...over,
  });

  test("heartbeats move nothing: the row's roster signature sleeps through a re-push", () => {
    const before = teamBarSig([roster()]);
    // Everything a presence heartbeat touches, and nothing a 32px face draws.
    const after = teamBarSig([
      roster({
        presence_input_at: 1_700_000_600_000,
        recent_session_messages: 42,
        recent_session_updated: 1_700_000_600_000,
        recent_session_last_message: "still going",
        daemon_last_seen: 1_700_000_600_000,
      }),
    ]);
    expect(after).toBe(before);
  });

  test("a face that changes wakes it", () => {
    const before = teamBarSig([roster()]);
    expect(teamBarSig([roster({ in_huddle: true })])).not.toBe(before);
    expect(teamBarSig([roster({ status: "busy" })])).not.toBe(before);
    expect(teamBarSig([roster({ image: "b.png" })])).not.toBe(before);
    expect(teamBarSig([roster({ name: "Ann D" })])).not.toBe(before);
    expect(teamBarSig([roster({ in_room_key: "dm:a:b" })])).not.toBe(before);
  });

  const status = (over: Partial<WalkieStatus> = {}): WalkieStatus => ({
    sending: null,
    incoming: null,
    liveRoom: null,
    unavailable: null,
    canReply: false,
    asr: "live",
    error: null,
    ...over,
  });

  test("the walkie signature the faces read moves on the three facts a face draws", () => {
    const quiet = walkieFacesSig(status());
    expect(
      walkieFacesSig(
        status({
          incoming: {
            fromUserId: "u_ann",
            fromName: "Ann",
            channelId: "channel",
            messageId: "message",
            roomKey: "dm:a:b",
            createdAt: 1_000,
          },
        }),
      ),
    ).not.toBe(quiet);
    expect(
      walkieFacesSig(
        status({
          sending: {
            channelId: "channel",
            roomKey: "dm:a:b",
            clientId: "draft",
            messageId: null,
            startedAt: 1_000,
            live: true,
            heardLive: false,
            openAt: null,
            transcript: "",
          },
        }),
      ),
    ).not.toBe(quiet);
    expect(
      walkieFacesSig(
        status({ liveRoom: { key: "dm:a:b", mode: "call", since: 1_000 } }),
      ),
    ).not.toBe(quiet);
  });

  test("and holds still through the engine's own bookkeeping", () => {
    const quiet = walkieFacesSig(status());
    // The recognizer going down, a reply becoming possible, an error clearing:
    // engine churn that changes no pixel of a face, on a surface mounted for
    // the life of the app. A room held as a burst is the face row's business
    // now (isInHuddle reads the row's links), so it moves this signature no more.
    expect(walkieFacesSig(status({ asr: "unavailable" }))).toBe(quiet);
    expect(walkieFacesSig(status({ canReply: true }))).toBe(quiet);
    expect(walkieFacesSig(status({ error: "that burst did not send" }))).toBe(
      quiet,
    );
    expect(
      walkieFacesSig(
        status({ liveRoom: { key: "dm:a:b", mode: "burst", since: 1_000 } }),
      ),
    ).toBe(quiet);
  });
});
