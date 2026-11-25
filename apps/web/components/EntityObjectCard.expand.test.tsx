import { expect, test } from "bun:test";
import { act, createElement as h } from "react";
import { ACCENT } from "../lib/entityCardAccent";
import { webBuilders } from "../test-helpers/builders";
import { expectPresent } from "../test-helpers/domExpect";
import { mountWeb } from "../test-helpers/mountWeb";
import { ObjectCardFrame } from "./EntityObjectCard";

const { session: sessions } = webBuilders("EntityObjectCard.expand.test.tsx");
const session = sessions.build({ title: "Read-only incident investigation" });
const href = "/conversation/" + session._id;

const card = () => document.querySelector<HTMLElement>(".entity-card")!;
const openLinks = (scope: Element) =>
  scope.querySelectorAll(".object-reveal-open-compact").length;
const expand = () =>
  act(() => card().dispatchEvent(new MouseEvent("click", { bubbles: true })));

function frame(flat: boolean) {
  return h(ObjectCardFrame, {
    accent: ACCENT.session,
    count: 1,
    ariaLabel: session.title!,
    href: href,
    openLabel: "Open session",
    footerId: session._id,
    resolved: true,
    served: true,
    header: flat ? undefined : { icon: h("i"), title: session.title! },
    flatBody: flat ? () => h("div", null, "body") : undefined,
    snippet: h("div", null, "snippet"),
    detail: h("div", null, "detail"),
  });
}

for (const flat of [true, false]) {
  test(`${flat ? "a flat" : "a header"} card keeps its surface when it opens; the corner drops to the chevron and the footer carries Open`, async () => {
    const { container } = await mountWeb(frame(flat));
    expect(
      container.querySelector(".entity-card")?.getAttribute("aria-label"),
    ).toBe(session.title);
    const closed = card().className;
    expect(closed).toContain("bg-sol-card");
    expect(closed).toContain("rounded-md");
    const corner = card().firstElementChild!;
    expect(openLinks(corner)).toBe(1);

    expand();
    expect(card().getAttribute("aria-expanded")).toBe("true");
    const open = card().className;
    expect(open).toContain("bg-sol-card");
    expect(open).toContain("rounded-md");
    expect(open).not.toContain("bg-sol-bg");
    expect(open).not.toContain("shadow-xl");
    expect(open).toContain(ACCENT.session.borderOpen);

    const cornerOpen = card().firstElementChild!;
    expect(openLinks(cornerOpen)).toBe(0);
    expectPresent(cornerOpen.querySelector("svg"));
    const detail = card().querySelector(".entity-card-expand");
    expectPresent(detail);
    expect(openLinks(detail)).toBe(1);
    expect(detail.querySelector("a")?.getAttribute("href")).toBe(href);
    expect(detail.textContent).toContain(session._id);
  });
}
