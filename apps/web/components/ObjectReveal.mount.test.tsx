import { expectAbsent, expectPresent } from "../test-helpers/domExpect";
import { afterAll, afterEach, expect, mock, test } from "bun:test";
import * as React from "react";
import { revealWheelGoesToParent } from "../lib/revealWheel";
import * as store from "../lib/revealHost";
import { webBuilders } from "../test-helpers/builders";
import { mountWeb } from "../test-helpers/mountWeb";

const { task } = webBuilders("ObjectReveal.mount.test.tsx");
const taskA = task.build();
const taskB = task.build();
const targetA = { href: `/tasks/${taskA.short_id}`, title: taskA.title };
const targetB = { href: `/tasks/${taskB.short_id}`, title: taskB.title };
const realRoutePane = { ...(await import("./RoutePane")) };
let nestedReference = false;
mock.module("./RoutePane", () => ({
  ...realRoutePane,
  RoutePane: ({ path }: { path: string }) => (
    <div data-path={path}>
      {nestedReference && (
        <reveal.RevealHost>
          <p>
            <reveal.RevealButton target={targetA} />
          </p>
        </reveal.RevealHost>
      )}
    </div>
  ),
}));
const reveal = await import("./ObjectReveal");

afterEach(() => {
  nestedReference = false;
});

afterAll(() => mock.module("./RoutePane", () => realRoutePane));

const mount = (node: React.ReactNode) =>
  mountWeb(node, {
    setup: (_backend, state) => {
      state.syncTable("tasks", [taskA, taskB]);
    },
  });
const click = (element: Element) =>
  React.act(async () => {
    element.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }),
    );
  });

test("the band portals into a slot right under the reference's paragraph and the header strip and the foot close it", async () => {
  const { RevealHost, RevealButton } = reveal;
  await mount(
    <div className="cc-content">
      <RevealHost persistKey="m1">
        <p>before</p>
        <p>
          see <RevealButton target={targetA} />
        </p>
        <p>after</p>
      </RevealHost>
    </div>,
  );
  const content = document.querySelector(".cc-content")!;
  await click(content.querySelector("button")!);
  // A pill in running text opens its band under its own line: the slot sits
  // inside the paragraph, right after the pill.
  expectPresent(
    content
      .querySelectorAll("p")[1]
      .querySelector("[data-reveal-slot][data-reveal-inline]"),
  );
  const band = content.querySelector(".object-reveal")!;
  expect(band.querySelector("[data-path]")?.getAttribute("data-path")).toBe(
    targetA.href,
  );
  expect(content.querySelector("button")?.getAttribute("aria-pressed")).toBe(
    "true",
  );
  // The grip is there for the resize; the bar above, the header strip and
  // the foot close. The small Open link in the bar does not close.
  expectPresent(band.querySelector(".object-reveal__grip .height-grip__bar"));
  expect(band.querySelectorAll(".object-reveal__open").length).toBe(1);
  expect(
    band.querySelector(".object-reveal__open-beside")?.getAttribute("title"),
  ).toBe("Open beside");
  expect(
    band
      .querySelector(".object-reveal__frame")
      ?.firstElementChild?.classList.contains("object-reveal__strip"),
  ).toBe(true);
  await click(content.querySelector(".object-reveal__open a")!);
  expectPresent(content.querySelector(".object-reveal"));
  expect(
    band
      .querySelector(".object-reveal__frame")
      ?.lastElementChild?.classList.contains("object-reveal__foot"),
  ).toBe(true);
  await click(band.querySelector(".object-reveal__foot")!);
  expectAbsent(content.querySelector("[data-reveal-slot]"));
  await click(content.querySelector("button")!);
  await click(content.querySelector(".object-reveal__strip")!);
  expectAbsent(content.querySelector("[data-reveal-slot]"));
  expect(content.querySelector("button")?.getAttribute("aria-pressed")).toBe(
    "false",
  );
  // The bar above the frame is itself a close.
  await click(content.querySelector("button")!);
  await click(
    content.querySelector(".object-reveal__open [data-reveal-close]")!,
  );
  expectAbsent(content.querySelector(".object-reveal"));
});

test("opening a reference in another host closes the first; a host inside the band is inert", async () => {
  const { RevealHost, RevealButton } = reveal;
  nestedReference = true;
  await mount(
    <div className="cc-content">
      <RevealHost persistKey="m1">
        <p>
          <RevealButton target={targetA} className="a" />
        </p>
      </RevealHost>
      <RevealHost persistKey="m2">
        <p>
          <RevealButton target={targetB} className="b" />
        </p>
      </RevealHost>
    </div>,
  );
  const content = document.querySelector(".cc-content")!;
  await click(content.querySelector("button.a")!);
  expect(content.querySelectorAll(".object-reveal").length).toBe(1);
  // The revealed page's own host renders no reveal control.
  expectAbsent(content.querySelector(".object-reveal button[aria-pressed]"));
  await click(content.querySelector("button.b")!);
  const bands = content.querySelectorAll(".object-reveal");
  expect(bands.length).toBe(1);
  expect(bands[0].querySelector("[data-path]")?.getAttribute("data-path")).toBe(
    targetB.href,
  );
  expect(content.querySelector("button.a")?.getAttribute("aria-pressed")).toBe(
    "false",
  );
  expect(content.querySelector("button.b")?.getAttribute("aria-pressed")).toBe(
    "true",
  );
});

test("wheel on the hatch lane scrolls the conversation; wheel in the frame scrolls the object", async () => {
  await mount(null);
  const band = document.createElement("div");
  band.className = "object-reveal";
  const lane = document.createElement("div");
  lane.className = "object-reveal__lane";
  const frame = document.createElement("div");
  frame.className = "object-reveal__frame";
  const body = document.createElement("div");
  body.className = "object-reveal__body";
  frame.appendChild(body);
  band.append(lane, frame);
  expect(revealWheelGoesToParent(lane, band)).toBe(true);
  expect(revealWheelGoesToParent(body, band)).toBe(false);
  expect(revealWheelGoesToParent(band, band)).toBe(true);
  const open = document.createElement("a");
  open.className = "object-reveal__open";
  band.appendChild(open);
  expect(revealWheelGoesToParent(open, band)).toBe(true);
});

// The fold a host wears while a band is open must not outlive the band. One
// conversation view serves every session the inbox selects, so the check has
// to run again when the surface swaps what it shows — otherwise the next
// session paints with the folded chrome and no band to explain it.
test("a surface stops hosting the band when it swaps to another subject", async () => {
  const { RevealHost, RevealButton } = reveal;
  const seen: boolean[] = [];
  function Surface({ subject }: { subject: string }) {
    const ref = React.useRef<HTMLSpanElement>(null);
    const hosting = store.useHostsReveal(ref, "[data-surface]", subject);
    seen.push(hosting);
    // Keyed: swapping the subject tears out the old transcript, and the band's
    // slot (plain DOM, placed under the reference) goes with it.
    return (
      <div key={subject} data-surface={subject}>
        <span ref={ref} />
        <RevealHost persistKey={subject}>
          <p>
            <RevealButton target={targetA} />
          </p>
        </RevealHost>
      </div>
    );
  }
  const { rerender } = await mount(<Surface subject="conv-a" />);
  expect(seen.at(-1)).toBe(false);
  await click(document.querySelector("[data-surface] button")!);
  expect(seen.at(-1)).toBe(true);
  expectPresent(document.querySelector(".object-reveal"));
  // The reveal stays open page-wide — nothing closed it — but this surface is
  // showing another conversation now, so it hosts nothing.
  await rerender(<Surface subject="conv-b" />);
  expect(store.currentReveal()).not.toBeNull();
  expect(seen.at(-1)).toBe(false);
});
