import { afterEach, describe, expect, jest, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { act } from "react";
import * as callManager from "../../lib/calls/callManager";
import { LONG_PRESS_MS } from "../../hooks/useLongPress";
import { mountWeb } from "../../test-helpers/mountWeb";
import { waitForPopupClose } from "../../test-helpers/waitForPopupClose";
import { standInForWalkieMedia } from "../../test-helpers/walkieMediaStandIn";
import { WalkiePttButton } from "../calls/WalkiePtt";

const ROOM = "dm:u_me:u_ann";
let restoreMedia: (() => void) | undefined;
afterEach(() => {
  restoreMedia?.();
  restoreMedia = undefined;
});

async function mountKey(ring?: { toUserIds: string[] }) {
  const voice = standInForWalkieMedia();
  const huddle = spyOn(callManager, "startHuddle").mockResolvedValue(undefined);
  restoreMedia = () => {
    huddle.mockRestore();
    voice.restore();
  };
  const { container, close } = await mountWeb(
    <WalkiePttButton
      roomKey={ROOM}
      resolveChannelId={() => "chan"}
      label="Talk"
      size="sm"
      ring={ring}
    />,
    {
      setup(_backend, store) {
        store.syncTable("clientState", { ui: { active_team_id: "team" } });
        store.syncTable("teams", [{ _id: "team", features: { calls: true } }]);
        store.syncTable("callConfig", { enabled: true });
      },
    },
  );
  const key = container.querySelector<HTMLButtonElement>("button.walkie-ptt")!;
  const fire = (type: string, init: MouseEventInit = {}) =>
    act(async () => {
      key.dispatchEvent(
        new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 10,
          button: 0,
          ...init,
        }),
      );
    });
  const menuItems = () => [
    ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ];
  return {
    key,
    fire,
    menuItems,
    menuItem: () => menuItems().find((el) => /Ring/.test(el.textContent ?? "")),
    voice,
    huddle,
    act,
    unmount: close,
  };
}

describe("walkie key: ring under the key", () => {
  test("a right click opens the one-item ring menu, and choosing it rings the room", async () => {
    const k = await mountKey({ toUserIds: ["u_ann", "u_bob"] });
    expect(k.key.title).toContain("Right click to ring");
    expect(k.menuItem()).toBeUndefined();

    await k.fire("contextmenu");
    const item = k.menuItem();
    expect(k.menuItems()).toHaveLength(1);
    expect(item?.textContent).toContain("Ring everyone and start a huddle");

    await k.act(async () => {
      item!.dispatchEvent(
        new MouseEvent("click", { bubbles: true, button: 0 }),
      );
    });
    await waitForPopupClose();
    expect(k.huddle.mock.calls).toEqual([
      [
        {
          roomKey: ROOM,
          toUserIds: ["u_ann", "u_bob"],
          anchorTitle: undefined,
          ringChannel: undefined,
          private: undefined,
        },
      ],
    ]);
    // The right click never toggled the talk.
    expect(k.voice.start).not.toHaveBeenCalled();
    await k.unmount();
  });

  test("a long press opens the menu and its click is spent — no burst starts", async () => {
    const k = await mountKey({ toUserIds: ["u_ann"] });
    jest.useFakeTimers();
    try {
      await k.fire("pointerdown");
      await act(async () => {
        jest.advanceTimersByTime(LONG_PRESS_MS);
      });
    } finally {
      jest.useRealTimers();
    }
    expect(k.menuItem()?.textContent).toContain("Ring them");
    await k.fire("pointerup");
    await k.fire("click");
    expect(k.voice.start).not.toHaveBeenCalled();
    await k.unmount();
  });

  test("a plain click still talks, and a key with no ring has no menu", async () => {
    const k = await mountKey();
    expect(k.key.title).not.toContain("Right click");
    await k.fire("contextmenu");
    expect(k.menuItem()).toBeUndefined();
    await k.fire("click");
    expect(k.voice.start.mock.calls).toEqual([["chan", ROOM]]);
    await k.unmount();
  });
});

describe("chat header: one voice control per room", () => {
  const page = readFileSync(
    new URL("../../app/chat/page.tsx", import.meta.url),
    "utf8",
  );
  // The chat header, not the first </header> in the file: the page grew an
  // earlier header, and an unanchored end made this slice empty.
  const headStart = page.indexOf('className="ch-head"');
  const header = page.slice(headStart, page.indexOf("</header>", headStart));

  test("the DM key carries the ring, and the huddle button is a channel's alone", () => {
    expect(header).toMatch(
      /<WalkiePttButton[\s\S]*?ring=\{\{ toUserIds: activeChannel\.dmMemberIds/,
    );
    // The huddle control (HuddleWithGuest wraps HuddleButton) renders only where there is no key: never for a DM.
    const huddleAt = header.indexOf("<HuddleWithGuest");
    expect(huddleAt).toBeGreaterThan(-1);
    const guard = header.slice(
      header.lastIndexOf("{activeChannel", huddleAt),
      huddleAt,
    );
    expect(guard).toContain('activeChannel.kind !== "dm"');
    expect(header).not.toMatch(/<HuddleWithGuest[\s\S]*?ring=/);
  });
});
