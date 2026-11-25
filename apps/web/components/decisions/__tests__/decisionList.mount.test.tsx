import { api } from "@codecast/convex/convex/_generated/api";
import { expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import {
  useInboxStore,
  type SessionDecisionItem,
} from "../../../store/inboxStore";
import { mountWeb } from "../../../test-helpers/mountWeb";
import { pending } from "../../../test-helpers/testConvex";
import { withTeamRoster } from "../../../test-helpers/teamRoster";
import { DecisionsList } from "../DecisionsPage";
import { DecisionPalette } from "../DecisionPalette";

const NOW = Date.now();
const H = 3_600_000;
const WS = "team:t1";
const dec = (
  id: string,
  over: Partial<SessionDecisionItem> = {},
): SessionDecisionItem => ({
  _id: id,
  short_id: `sd-${id.slice(1)}`,
  conversation_id: "c1",
  session_id: "s1",
  question: `Question ${id}`,
  options: [{ label: "Ship" }, { label: "Hold" }],
  blocking: true,
  status: "pending",
  created_at: NOW - H,
  in_queue: false,
  team_workspace: WS,
  category: "scope",
  ...over,
});
const flow = (
  over: Partial<SessionDecisionItem>,
): Partial<SessionDecisionItem> => ({
  workflow_run_id: "r1",
  task_id: "t9",
  gate_node_id: "decide",
  team_workspace: undefined,
  line_workspace: WS,
  ...over,
});
const fixture = () => ({
  d1: dec(
    "d1",
    flow({
      holder: { kind: "user", id: "u2" },
      problem_severity: 9,
      problem_findings: 12,
      problem_reach: 3,
    }),
  ),
  d2: dec("d2", flow({ asked_user_ids: [] })),
  d3: dec("d3", {
    holder: { kind: "user", id: "u1" },
    in_queue: true,
    created_at: NOW - 30 * H,
  }),
  d4: dec("d4", {
    holder: { kind: "user", id: "u2" },
    blocking: false,
    category: "approach",
  }),
});
let host: HTMLElement;
async function mount(
  ui: ReactElement,
  search = "tab=team",
  decisions = fixture(),
) {
  const web = await mountWeb(ui, {
    path: "/decisions?" + search,
    dispatch: true,
    setup(backend, store) {
      store.syncTable("currentUser", { _id: "u1", name: "Me" });
      useInboxStore.setState({
        ...withTeamRoster(
          [
            { _id: "u1", name: "Me" },
            { _id: "u2", name: "Sam" },
            { _id: "u3", name: "Jo" },
          ],
          { team: "t1", clientState: store.clientState },
        ),
        clientStateInitialized: true,
      });
      store.syncTable("sessionDecisions", [
        ...Object.values(decisions),
        dec("d9", {
          team_workspace: "team:other",
          holder: { kind: "user", id: "u2" },
        }),
      ]);
      backend.set(api.decisionTeamList.listForTeam, pending);
      backend.set(api.sessionDecisions.listOpenForLines, pending);
      backend.set(api.org.roles, pending);
      backend.set(api.org.tree, pending);
      backend.mutation(api.dispatch.dispatch, null);
    },
  });
  host = web.container;
  return web;
}
const rows = () =>
  [...host.querySelectorAll<HTMLElement>("[data-decision-row]")].map(
    (r) => `${r.dataset.decisionRow}@${r.dataset.decisionOwner}`,
  );
const headers = () =>
  [...host.querySelectorAll<HTMLElement>("[data-list-scroll] [data-index]")]
    .filter((r) => !r.querySelector("[data-decision-row]"))
    .map((r) => r.textContent?.replace(/\s+/g, " ").trim());
const click = (el: Element | null | undefined) =>
  act(async () => {
    (el as HTMLElement).click();
  });

test("Team groups every open decision by its owner, Unassigned a group of its own", async () => {
  const m = await mount(<DecisionsList />);
  expect(headers()).toEqual(["SSam(2)", "MMe (you)(1)", "Unassigned(1)"]);
  expect(rows()).toEqual([
    "sd-1@user:u2",
    "sd-4@user:u2",
    "sd-3@user:u1",
    "sd-2@none",
  ]);
  const tabs = [...host.querySelectorAll("[data-list-tabs] button")].map(
    (b) => b.textContent,
  );
  expect(tabs).toEqual([
    "Mine1",
    "Team4",
    "Unassigned1",
    "Escalated",
    "Answered",
  ]);
  await m.close();
});

test("a filter narrows the list, shows as a chip, and saves as a view of the Decisions page", async () => {
  const m = await mount(
    <DecisionsList />,
    "tab=team&blocking=blocking&owner=user:u2",
  );
  expect(rows()).toEqual(["sd-1@user:u2"]);
  expect(host.querySelector(".cq-filter-bar")?.textContent).toContain(
    "Blocking",
  );
  await click(
    [...host.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Save view"),
    ),
  );
  const input = host.querySelector<HTMLInputElement>(
    "input[placeholder='View name...']",
  )!;
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setter.call(input, "Sam's blockers");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    input
      .closest("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(m.backend.mutations.map(({ args }) => args)).toMatchObject([
    { action: "createSavedView", args: [{ name: "Sam's blockers" }] },
  ]);
  expect(Object.values(m.store.getState().savedViews)).toMatchObject([
    {
      name: "Sam's blockers",
      page: "decisions",
      prefs: { tab: "team", owner: "user:u2", blocking: "blocking" },
    },
  ]);
  await m.close();
});

test("rows picked together open the decision palette, and assigning them repaints their owner at once", async () => {
  const m = await mount(<DecisionsList />);
  for (const id of ["sd-1", "sd-4"])
    await click(
      host
        .querySelector(`[data-decision-row="${id}"]`)!
        .closest("[data-list-row-state], [data-index] > div")!
        .querySelector("button"),
    );
  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "d",
        code: "KeyD",
        bubbles: true,
      }),
    );
  });
  const palette = useInboxStore.getState().palette;
  expect([palette.targetType, palette.targets.map((t) => t.short_id)]).toEqual([
    "decision",
    ["sd-1", "sd-4"],
  ]);

  await m.rerender(
    <>
      <DecisionsList />
      <DecisionPalette
        targets={palette.targets}
        mode={palette.initialMode}
        standalone
        onClose={() => useInboxStore.getState().closePalette()}
      />
    </>,
  );
  const item = (key: string) =>
    document.querySelector(`[data-decision-palette-item="${key}"]`);
  expect(
    [...document.querySelectorAll("[data-decision-palette-item]")].map((e) =>
      e.getAttribute("data-decision-palette-item"),
    ),
  ).toEqual(["assign", "pass", "escalate", "answer", "dismiss"]);
  await click(item("assign"));
  await click(item("user:u3"));
  expect(
    ["d1", "d4"].map(
      (id) => useInboxStore.getState().sessionDecisions[id]?.passed_to,
    ),
  ).toEqual([
    { by: "u1", kind: "user", id: "u3" },
    { by: "u1", kind: "user", id: "u3" },
  ]);
  expect(m.backend.mutations.map(({ args }) => args)).toMatchObject([
    { action: "passDecision", args: ["d1", { kind: "user", id: "u3" }] },
    { action: "passDecision", args: ["d4", { kind: "user", id: "u3" }] },
  ]);
  expect(rows()).toEqual([
    "sd-1@user:u3",
    "sd-4@user:u3",
    "sd-3@user:u1",
    "sd-2@none",
  ]);
  expect(headers()).toEqual(["JJo(2)", "MMe (you)(1)", "Unassigned(1)"]);
  await m.close();
});

test("an answer every picked decision offers answers them all; one some lack is not offered", async () => {
  const decisions = fixture();
  const distinctOptions: SessionDecisionItem = {
    ...decisions.d4,
    options: [{ label: "Hold" }, { label: "Later" }],
  };
  const m = await mount(
    <DecisionPalette
      targets={[decisions.d3, distinctOptions]}
      mode="answer"
      standalone
      onClose={() => {}}
    />,
    undefined,
    { ...decisions, d4: distinctOptions },
  );
  const answers = [
    ...document.querySelectorAll("[data-decision-palette-item^='answer:']"),
  ].map((e) => e.textContent);
  expect(answers).toEqual(["Hold"]);
  await m.close();
});

test("Every flow narrows the page to the flows' decisions, rows and owners unchanged", async () => {
  const m = await mount(<DecisionsList />, "tab=team&source=flows&group=none");
  expect(rows().sort()).toEqual(["sd-1@user:u2", "sd-2@none"]);
  const sd1 = host.querySelector('[data-decision-row="sd-1"]')!;
  expect([
    sd1.querySelector("[data-decision-reach]")?.textContent,
    sd1.querySelector("[data-decision-findings]")?.textContent,
  ]).toEqual(["3", "12"]);
  await m.close();
});
