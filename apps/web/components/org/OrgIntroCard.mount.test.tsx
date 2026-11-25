import { expect, test } from "bun:test";
import { api } from "@codecast/convex/convex/_generated/api";
import { act } from "react";
import { toast } from "sonner";
import { ORG_INTRO_HEAD_OF_PEOPLE } from "../../lib/orgIntro";
import {
  composerHasText,
  composerLift,
  orgIntroCardMayRise,
  ORG_MEET_COMPOSER_GAP,
  ORG_MEET_LINES,
  ORG_MEET_SETTLE_MS,
  ORG_MEET_TITLE,
  ORG_MEET_TOAST_ID,
  type OrgIntroCardFacts,
} from "../../lib/orgIntroCard";
import { useInboxStore } from "../../store/inboxStore";
import { webBuilders } from "../../test-helpers/builders";
import { expectAbsent, expectPresent } from "../../test-helpers/domExpect";
import { mountWeb } from "../../test-helpers/mountWeb";
import { waitForDom } from "../../test-helpers/waitForDom";
import { OrgIntroAnywhere } from "./OrgIntroAnywhere";

const { teamMember } = webBuilders("OrgIntroCard.mount.test.tsx");
const viewer = teamMember.build();
const team = teamMember.build()._id;

const q = <T extends Element = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector);
const qa = (selector: string) => [
  ...document.querySelectorAll<HTMLElement>(selector),
];

test("the card's gate: settled store, a person, not the org page, not a phone, no call, no draft, unsold", async () => {
  await mountWeb(null);
  const ok: OrgIntroCardFacts = {
    initialized: true,
    signedIn: true,
    onOrgPage: false,
    phone: false,
    callPhase: "idle",
    composerHasText: false,
    introSeen: false,
    upsellSeen: false,
  };
  expect(orgIntroCardMayRise(ok)).toBe(true);
  const closed: Array<Partial<OrgIntroCardFacts>> = [
    { initialized: false },
    { signedIn: false },
    { onOrgPage: true },
    { phone: true },
    { callPhase: "connected" },
    { callPhase: "ringing_out" },
    { callPhase: "connecting" },
    { composerHasText: true },
    { introSeen: true },
    { upsellSeen: true },
  ];
  for (const c of closed)
    expect(orgIntroCardMayRise({ ...ok, ...c })).toBe(false);

  document.body.insertAdjacentHTML(
    "beforeend",
    "<div id='c'><textarea></textarea><div contenteditable='true'></div></div>",
  );
  expect(composerHasText(document)).toBe(false);
  document.querySelector("textarea")!.value = "  half a thought";
  expect(composerHasText(document)).toBe(true);
  document.querySelector("textarea")!.value = "";
  document.querySelector<HTMLElement>("[contenteditable]")!.textContent =
    "typing";
  expect(composerHasText(document)).toBe(true);
  document.getElementById("c")!.remove();

  expect(composerLift(document, 800)).toBe(0);
  document.body.insertAdjacentHTML(
    "beforeend",
    "<div id='composer' data-sv-composer></div>",
  );
  const composer = document.getElementById("composer")!;
  composer.getBoundingClientRect = () =>
    ({
      top: 710,
      bottom: 800,
      height: 90,
      width: 600,
      left: 0,
      right: 600,
      x: 0,
      y: 710,
      toJSON() {},
    }) as DOMRect;
  expect(composerLift(document, 800)).toBe(
    800 - 32 - (710 - ORG_MEET_COMPOSER_GAP),
  );
  composer.getBoundingClientRect = () =>
    ({
      top: 0,
      bottom: 0,
      height: 0,
      width: 0,
      left: 0,
      right: 0,
      x: 0,
      y: 0,
      toJSON() {},
    }) as DOMRect;
  expect(composerLift(document, 800)).toBe(0);
  composer.remove();
});

type Fixture = {
  initialized?: boolean;
  path?: string;
  phone?: boolean;
  call?: boolean;
  draft?: boolean;
  introSeen?: boolean;
  upsellSeen?: boolean;
};

async function mountAnywhere(facts: Fixture = {}) {
  const callbacks: Array<() => void> = [];
  const web = await mountWeb(
    <>
      <OrgIntroAnywhere />
      {facts.draft && <textarea defaultValue="a reply in progress" />}
    </>,
    {
      path: facts.path ?? "/inbox",
      dispatch: true,
      setup(backend, store) {
        backend.mutation(api.dispatch.dispatch, null);
        store.syncTable("currentUser", viewer);
        store.syncTable("teams", [{ _id: team, features: { org: true } }]);
        store.syncTable("clientState", {
          ui: {
            active_team_id: team,
            show_characters: true,
            org_intro_seen: facts.introSeen,
            org_upsell_seen: facts.upsellSeen,
          },
        });
        if (facts.initialized === false)
          useInboxStore.setState({ clientStateInitialized: false });
        if (facts.call) store.setCallState({ phase: "connected" });
        if (facts.phone) {
          const match = window.matchMedia;
          window.matchMedia = (query) => ({
            ...match(query),
            matches: query === "(max-width: 767px)",
          });
        }
        const schedule = window.setTimeout.bind(window);
        Object.defineProperty(window, "setTimeout", {
          configurable: true,
          value(callback: TimerHandler, delay?: number, ...args: unknown[]) {
            if (
              delay !== ORG_MEET_SETTLE_MS ||
              typeof callback !== "function"
            ) {
              return schedule(callback, delay, ...args);
            }
            callbacks.push(() => callback(...args));
            return schedule(() => {}, delay);
          },
        });
      },
    },
  );
  const writes = () =>
    web.backend.mutations.filter(
      ({ args }) =>
        typeof args === "object" &&
        args !== null &&
        "action" in args &&
        args.action === "updateClientUI",
    );
  const settle = async (raises: boolean) => {
    await act(async () => {
      callbacks.splice(0).forEach((callback) => callback());
    });
    if (raises) {
      await act(() =>
        waitForDom(document.body, () => q("[data-org-meet]") !== null),
      );
      expect(
        toast.getToasts().filter(({ id }) => id === ORG_MEET_TOAST_ID),
      ).toHaveLength(1);
    } else {
      expect(
        toast.getToasts().filter(({ id }) => id === ORG_MEET_TOAST_ID),
      ).toEqual([]);
      expectAbsent(q("[data-org-meet]"));
    }
  };
  return { ...web, settle, writes };
}

async function answer(selector: string) {
  const control = q<HTMLButtonElement>(selector);
  expectPresent(control);
  await act(async () => control.click());
  await act(
    () =>
      new Promise<void>((painted) => requestAnimationFrame(() => painted())),
  );
  expect(
    toast.getToasts().filter(({ id }) => id === ORG_MEET_TOAST_ID),
  ).toEqual([]);
}

test("the card rises once the page settles and Not now sells it", async () => {
  const web = await mountAnywhere();
  expectAbsent(q("[data-org-meet]"));
  await web.settle(true);
  expect(q("[data-org-meet] .rise-card-title")?.textContent).toBe(
    ORG_MEET_TITLE,
  );
  expect(
    qa("[data-org-meet] .rise-card-copy").map((p) => p.textContent),
  ).toEqual([...ORG_MEET_LINES]);
  expect(q("[data-org-meet] img")?.getAttribute("data-avatar")).toBe(
    ORG_INTRO_HEAD_OF_PEOPLE,
  );
  await answer("[data-org-meet] [data-rise-later]");
  expect(web.writes()).toHaveLength(1);
  expect(web.writes()[0]).toMatchObject({
    args: { args: [{ org_upsell_seen: true }] },
  });
  expect(web.navigationLog).toEqual([{ path: "/inbox", action: "pop" }]);
  const latest = toast
    .getHistory()
    .findLast(
      (entry) => entry.id === ORG_MEET_TOAST_ID && "onDismiss" in entry,
    );
  if (!latest || !("onDismiss" in latest))
    throw new Error("The intro toast has no swipe handler");
  await act(async () => latest.onDismiss?.(latest));
  expect(web.writes()).toHaveLength(1);
});

test("See it opens the org page and sells it", async () => {
  const web = await mountAnywhere();
  await web.settle(true);
  await answer("[data-org-meet] [data-rise-primary]");
  expect(web.navigationLog.slice(1)).toEqual([
    { path: "/org?panel=open", action: "push" },
  ]);
  expect(web.writes()).toHaveLength(1);
  expect(web.writes()[0]).toMatchObject({
    args: { args: [{ org_upsell_seen: true }] },
  });
});

const blocked: Array<[string, Fixture]> = [
  ["phone", { phone: true }],
  ["call", { call: true }],
  ["draft", { draft: true }],
  ["Org page", { path: "/org" }],
  ["intro seen", { introSeen: true }],
  ["upgrade seen", { upsellSeen: true }],
  ["cold store", { initialized: false }],
];
for (const [reason, facts] of blocked) {
  test("the introduction stays hidden with " + reason, async () => {
    const web = await mountAnywhere(facts);
    await web.settle(false);
    expect(web.writes()).toEqual([]);
  });
}
