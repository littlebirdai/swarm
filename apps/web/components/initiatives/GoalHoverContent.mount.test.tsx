import { expect, spyOn, test } from "bun:test";
import { act } from "react";
import { HoverCardClose } from "../../lib/hoverCardsOff";
import { webBuilders } from "../../test-helpers/builders";
import { expectPresent } from "../../test-helpers/domExpect";
import { mountWeb } from "../../test-helpers/mountWeb";
import { GoalHoverContent } from "./GoalHoverContent";
import { FIXTURE_INITIATIVES } from "./initiativeFixture";

test("the goal card opens like every object card", async () => {
  const viewer = webBuilders("goal hover").teamMember.build();
  const parent = {
    ...FIXTURE_INITIATIVES[0],
    title: "Parent",
    short_id: "in-9",
    workspace: `user:${viewer._id}`,
    project_ids: [],
  };
  const goal = {
    ...parent,
    _id: FIXTURE_INITIATIVES[1]._id,
    short_id: "in-1",
    title: "Grow",
    parent_initiative_id: parent._id,
  };
  const web = await mountWeb(<GoalHoverContent goal={goal} />, {
    setup(_backend, store) {
      store.syncTable("currentUser", viewer);
      store.syncTable("clientState", { ui: {} });
      store.syncTable("initiatives", [parent, goal]);
    },
  });
  const calls: string[] = [];
  const open = spyOn(window, "open").mockImplementation(() => {
    calls.push("tab");
    return null;
  });
  const card = () => {
    const node = web.container.querySelector("[data-initiative-hover='in-1']");
    expectPresent(node);
    return node;
  };
  const click = (element: Element, init: MouseEventInit = {}) =>
    act(async () => {
      element.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          button: 0,
          ...init,
        }),
      );
    });
  const enter = (init: KeyboardEventInit = {}) =>
    act(async () => {
      card().dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "Enter",
          ...init,
        }),
      );
    });
  try {
    expect(card().getAttribute("data-object-card")).toBe("initiative");
    expect(card().getAttribute("aria-label")).toBe("Open goal");
    expect(card().textContent).not.toContain("Open goal");
    await click(card());
    await enter();
    expect(web.navigationLog.slice(1)).toEqual([
      { action: "push", path: "/goals/in-1" },
      { action: "push", path: "/goals/in-1" },
    ]);
    await click(card(), { metaKey: true });
    await enter({ ctrlKey: true });
    expect(open.mock.calls).toEqual([
      ["/goals/in-1", "_blank", "noopener"],
      ["/goals/in-1", "_blank", "noopener"],
    ]);
    expect(web.navigationLog).toHaveLength(3);
    const link = card().querySelector("[data-summary-serves-item='in-9']");
    expectPresent(link);
    expect(link.textContent).toBe("Parent");
    await click(link);
    expect(web.navigationLog.slice(3)).toEqual([
      { action: "push", path: "/goals/in-9" },
    ]);
    expect(open.mock.calls).toHaveLength(2);

    calls.length = 0;
    await web.rerender(
      <GoalHoverContent
        goal={goal}
        onOpen={() => calls.push(`pill:${web.navigationLog.length}`)}
      />,
    );
    await click(card());
    await click(card(), { ctrlKey: true });
    expect(calls).toEqual(["pill:4", "pill:5", "tab"]);
    expect(web.navigationLog.slice(4)).toEqual([
      { action: "push", path: "/goals/in-1" },
    ]);
    expect(open.mock.calls.at(-1)).toEqual([
      "/goals/in-1",
      "_blank",
      "noopener",
    ]);

    calls.length = 0;
    await web.rerender(
      <GoalHoverContent
        goal={goal}
        onOpen={(event) => {
          event.preventDefault();
          calls.push("pill opened it");
        }}
      />,
    );
    await click(card());
    expect(calls).toEqual(["pill opened it"]);
    expect(web.navigationLog).toHaveLength(5);
    expect(open.mock.calls).toHaveLength(3);

    calls.length = 0;
    await web.rerender(
      <HoverCardClose.Provider
        value={() => calls.push(`closed:${web.navigationLog.length}`)}
      >
        <GoalHoverContent goal={goal} />
      </HoverCardClose.Provider>,
    );
    await click(card());
    await enter();
    expect(calls).toEqual(["closed:5", "closed:6"]);
    expect(web.navigationLog.slice(5)).toEqual([
      { action: "push", path: "/goals/in-1" },
      { action: "push", path: "/goals/in-1" },
    ]);
  } finally {
    open.mockRestore();
    await web.close();
  }
});
