import { expect, test } from "bun:test";
import type { ReactElement } from "react";
import { expectAbsent, expectPresent } from "../../test-helpers/domExpect";
import { mountWeb } from "../../test-helpers/mountWeb";
import { HuddleButton, SessionHuddleButton } from "../calls/OccupancyChip";

function mount(node: ReactElement, enabled = true) {
  return mountWeb(node, {
    setup(_backend, store) {
      store.syncTable("teams", [{ _id: "t1", features: { calls: enabled } }]);
      store.syncTable("clientState", { ui: { active_team_id: "t1" } });
      store.syncTable("callConfig", { enabled: true });
    },
  });
}

function button(container: HTMLElement) {
  const found = container.querySelector("button");
  expectPresent(found);
  return found;
}

test("the header scale is the headphones alone", async () => {
  const web = await mount(<HuddleButton roomKey="channel:ch1" compact />);
  const huddle = button(web.container);
  expect(huddle.textContent).not.toContain("Huddle");
  expect(huddle.textContent).not.toContain("Ring");
  expectPresent(huddle.querySelector("svg"));
  await web.close();
});

test("the chat page keeps the word beside it", async () => {
  const web = await mount(<HuddleButton roomKey="channel:ch1" />);
  expect(button(web.container).querySelector("span")?.textContent).toBe(
    "Huddle",
  );
  await web.close();
});

test("a room with people to ring says Ring, at the scale that has room", async () => {
  const web = await mount(<HuddleButton roomKey="dm:ua:ub" ring={["ub"]} />);
  expect(button(web.container).querySelector("span")?.textContent).toBe("Ring");
  await web.close();
});

test("dropping the word does not drop the label", async () => {
  const web = await mount(<HuddleButton roomKey="channel:ch1" compact />);
  const huddle = button(web.container);
  expect(huddle.title).toContain(
    "Start a huddle and buzz everyone in the channel",
  );
  expect(huddle.getAttribute("aria-label")).toBe(huddle.title);
  await web.close();
});

test("ringing several people reads as everyone, one person as them", async () => {
  const web = await mount(
    <HuddleButton roomKey="dm:ua:ub" ring={["ub"]} compact />,
  );
  expect(button(web.container).title).toContain("ring them");
  await web.rerender(
    <HuddleButton roomKey="dm:ua:ub:uc" ring={["ub", "uc"]} compact />,
  );
  expect(button(web.container).title).toContain("ring everyone here");
  await web.close();
});

test("a session's button promises the agent is listening", async () => {
  const web = await mount(<SessionHuddleButton conversationId="conv1" />);
  const huddle = button(web.container);
  expect(huddle.title).toContain("Talk to this session");
  expect(huddle.textContent).not.toContain("Huddle");
  await web.close();
});

test("calling switched off draws nothing at all", async () => {
  const web = await mount(
    <>
      <HuddleButton roomKey="channel:ch1" compact />
      <SessionHuddleButton conversationId="conv1" />
    </>,
    false,
  );
  expectAbsent(web.container.querySelector("button"));
  expect(web.container.textContent).toBe("");
  await web.close();
});
