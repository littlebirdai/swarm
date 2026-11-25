import { api } from "@codecast/convex/convex/_generated/api";
import { expect, test } from "bun:test";
import React from "react";
import { expectAbsent, expectPresent } from "../../test-helpers/domExpect";
import { mountWeb } from "../../test-helpers/mountWeb";
import { pending } from "../../test-helpers/testConvex";
import { waitForPopupClose } from "../../test-helpers/waitForPopupClose";
import { useInboxStore } from "../../store/inboxStore";
import { EntityObjectCard } from "../EntityObjectCard";
import { ReviewComposerContext } from "../reviewContext";
import { ORG_FIXTURE } from "./orgFixture";
import type { OrgProposalChange, OrgProposalListRow } from "./orgStaffingTypes";
import { OrgHoverContext } from "./proposalContexts";

const h = React.createElement;
const AUTHOR = {
  kind: "role" as const,
  id: "role-cos",
  name: "Head of People",
  handle: "head-of-people",
  short_id: "or-9",
  avatar: "fox",
};
const proposal = (
  id: string,
  short_id: string,
  title: string,
  status: "open" | "resolved" = "open",
  summary_md = `Why ${title.toLowerCase()}.`,
): OrgProposalListRow => ({
  _id: id,
  short_id,
  team_id: "fixture-team",
  author: AUTHOR,
  title,
  summary_md,
  mode: "review",
  status,
  created_at: Date.now() - 600_000,
});
const change = (
  id: string,
  proposal_id: string,
  seq: number,
  c: OrgProposalChange["change"],
  status: OrgProposalChange["status"] = "proposed",
  extra: Partial<OrgProposalChange> = {},
): OrgProposalChange => ({
  _id: id,
  proposal_id,
  seq,
  change: c,
  rationale: `Because ${id}.`,
  evidence: [],
  status,
  ...extra,
});

const ROLE: OrgProposalChange["change"] = {
  kind: "role",
  name: "Head of Platform",
  handle: "platform",
  reports_to: "me",
  scope: { projects: ["Platform"] },
};
const MOVE: OrgProposalChange["change"] = {
  kind: "move",
  handle: "growth",
  reports_to: "@platform",
};
const LIMIT: OrgProposalChange["change"] = {
  kind: "budget",
  handle: "growth",
  caps: { wakes_per_day: 12, tokens_per_day: 800_000 },
};
// A letter past four lines: the lead folds and "Read the rest" opens the whole of it.
const LONG_LETTER = `${"Platform work is spread over four people and nobody owns the week. ".repeat(14).trim()}\n\nThe rest of the letter names the sessions this would move.`;

const proposals: Record<string, OrgProposalListRow> = {
  p1: proposal("p1", "op-1", "Bring platform under one lead"),
  // The whole-proposal note the person sent with their approvals, stored on the row (S39).
  p2: {
    ...proposal("p2", "op-2", "Growth reports to platform", "resolved"),
    reply: {
      verdict: "note",
      text: "Do the plans next",
      at: Date.now() - 60_000,
      by: "user-1",
    },
  },
  p3: proposal("p3", "op-3", "A second attempt"),
  p4: proposal("p4", "op-4", "Keep growth within bounds"),
  p5: proposal("p5", "op-5", "Platform lead, within bounds"),
  p7: proposal("p7", "op-7", "Platform, landing"),
  p8: proposal("p8", "op-8", "A long letter", "open", LONG_LETTER),
};
const changes: Record<string, OrgProposalChange> = {
  "c1-role": change("c1-role", "p1", 1, ROLE),
  "c1-move": change("c1-move", "p1", 2, MOVE),
  "c2-role": change("c2-role", "p2", 1, ROLE, "applied", {
    applied_at: Date.now() - 60_000,
  }),
  "c2-move": change("c2-move", "p2", 2, MOVE, "applied"),
  "c3-role": change("c3-role", "p3", 1, ROLE, "failed", {
    applied_note: "A role already answers to @platform",
  }),
  "c3-move": change("c3-move", "p3", 2, MOVE, "applied"),
  "c4-limit": change("c4-limit", "p4", 1, LIMIT, "proposed", {
    rationale: "Growth wakes 30 times a day.",
  }),
  "c5-role": change("c5-role", "p5", 1, ROLE),
  // The limit rides on the role this proposal creates.
  "c5-limit": change(
    "c5-limit",
    "p5",
    2,
    { ...LIMIT, handle: "platform" },
    "proposed",
    { rationale: "Platform gets 800k tokens." },
  ),
  "c7-role": change("c7-role", "p7", 1, ROLE, "accepted"),
  "c7-move": change("c7-move", "p7", 2, MOVE, "accepted"),
  "c8-role": change("c8-role", "p8", 1, ROLE),
};

const CONV = "conv-1";
const composer = {
  quote() {},
  submit() {},
  populate() {},
  conversationId: CONV,
  canSend: true,
  send: () => {},
};
// The same conversation read by someone whose composer is not there (a guest, a non-owner): the bridge carries the id and no send.
const readOnlyComposer = {
  quote() {},
  submit() {},
  populate() {},
  conversationId: CONV,
  canSend: false,
};
/** The answers a batch holds, as the tray would read them. */
const batch = (key = CONV) =>
  (useInboxStore.getState().reviewComments[key] ?? []).map(
    ({ proposal, body }) => [
      proposal?.card,
      proposal?.verdict,
      body,
      proposal?.seqs,
      proposal?.change_ids,
      proposal?.ordinal,
      proposal?.subject,
    ],
  );

async function mount(ui: React.ReactNode, focusChangeId?: string) {
  return mountWeb(ui, {
    dispatch: true,
    setup(backend, store) {
      store.syncTable("orgTree", ORG_FIXTURE);
      if (focusChangeId) store.setOrgFocusChangeId(focusChangeId);
      store.syncTable("orgProposals", Object.values(proposals));
      store.syncTable("orgProposalChanges", Object.values(changes));
      useInboxStore.setState({
        clientState: {
          ...store.clientState,
          ui: { ...store.clientState.ui, show_characters: true },
        },
      });
      backend.set(api.org.roles, pending);
      backend.set(api.org.tree, pending);
      backend.set(api.orgProposals.list, pending);
      backend.set(api.orgProposals.get, ({ proposal }) => {
        const row = Object.values(proposals).find(
          (p) => p.short_id === proposal,
        );
        if (!row) return pending;
        return {
          ...row,
          changes: Object.values(changes).filter(
            (c) => c.proposal_id === row._id,
          ),
        };
      });
      backend.mutation(api.dispatch.dispatch, null);
    },
  });
}
const card = (ref: string) =>
  h("div", { "data-card": ref }, h(EntityObjectCard, { refId: ref, count: 1 }));
const inThread = (ui: React.ReactNode) =>
  h(ReviewComposerContext.Provider, { value: composer }, ui);
const q = (sel: string) => document.querySelector<HTMLElement>(sel)!;
const qa = (sel: string) =>
  Array.from(document.querySelectorAll<HTMLElement>(sel));
const click = (el: HTMLElement) =>
  React.act(() =>
    el.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    ),
  );
const key = (el: HTMLElement, k: string) =>
  React.act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  });
const type = (el: HTMLTextAreaElement, text: string) =>
  React.act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });

const sentences = (c: HTMLElement) =>
  Array.from(c.querySelectorAll<HTMLElement>("[data-subject-sentence]")).map(
    (s) => s.textContent,
  );
const subjects = (c: HTMLElement) =>
  Array.from(c.querySelectorAll<HTMLElement>("[data-subject]"));
const foot = (c: HTMLElement) =>
  c.querySelector<HTMLElement>("[data-ledger-close]")!;
/** Approving a new role opens the shared confirm; this presses its confirm. */
async function confirmOnline() {
  click(q("[data-switch-confirm]"));
  await waitForPopupClose();
}

test("a proposed proposal: meta, lead, totals, one entry per subject; Accept stages a band in the batch and decides nothing; Undo takes it back", async () => {
  const root = await mount(inThread(card("op-1")));
  const c = q("[data-card='op-1']");
  expectPresent(c.querySelector(".entity-card"));
  expect(c.textContent).toContain("Bring platform under one lead");
  // The meta line counts the cards a person sees.
  expect(
    c.querySelector("[data-proposal-meta]")!.getAttribute("data-proposal-meta"),
  ).toBe("2 to decide");
  expect(
    c.querySelector("[data-proposal-author='role']")!.textContent,
  ).toContain("Head of People");
  // The head names the author by face and name; the handle stays off it. In a thread the head links to the proposal's page.
  expect(
    c.querySelector("[data-proposal-author='role']")!.textContent,
  ).not.toContain("@");
  expect(
    c.querySelector(".entity-card")!.getAttribute("data-entity-card"),
  ).toBe("proposal");
  expectPresent(c.querySelector("a[title='Open proposal']"));
  // The author's summary at the top, then the totals in one sentence.
  expectAbsent(c.querySelector("[data-proposal-letter]"));
  expect(c.querySelector("[data-proposal-summary]")!.textContent).toBe(
    "Why bring platform under one lead.",
  );
  expect(c.querySelector("[data-proposal-totals]")!.textContent).toBe(
    "2 changes: 1 new role and 1 move.",
  );
  expect(
    c.querySelector("[data-proposal-card]")!.getAttribute("data-proposal-card"),
  ).toBe("op-1");
  expect(
    c.querySelector("[data-proposal-card]")!.getAttribute("data-proposal-work"),
  ).toBe("structure");
  expectAbsent(c.querySelector("[data-proposal-readonly]"));

  // The ledger: the new role first, then the role moved under it, each a plain sentence.
  expect(
    subjects(c).map((s) => [
      s.getAttribute("data-subject"),
      s.getAttribute("data-subject-status"),
      s.getAttribute("data-change-ids"),
    ]),
  ).toEqual([
    ["role:platform", "proposed", "c1-role"],
    ["role:growth", "proposed", "c1-move"],
  ]);
  expect(sentences(c)).toEqual([
    "Add the role Head of Platform, reporting to you.",
    "Have Head of Growth report to Head of Platform.",
  ]);
  expect(
    Array.from(c.querySelectorAll("[data-subject-ordinal]")).map(
      (n) => n.textContent,
    ),
  ).toEqual(["1", "2"]);
  // The move says where the role reported before, as a face and a name.
  const reports = c.querySelector<HTMLElement>(
    "[data-subject='role:growth'] [data-field='reports_to']",
  )!;
  expect(reports.getAttribute("data-field-before")).toBe("Ashot Petrosian");
  expect(reports.getAttribute("data-field-after")).toBe("Head of Platform");
  expectPresent(reports.querySelector("[data-face='person']"));
  expectPresent(reports.querySelector("[data-face='role']"));
  // Two entries: each change's reason reads as its own Why row.
  expect(
    Array.from(c.querySelectorAll("[data-subject-why]")).map(
      (w) => w.textContent,
    ),
  ).toEqual(["Because c1-role.", "Because c1-move."]);
  expect(
    c.querySelector(
      "[data-tree-row], [data-ghost-tag], [data-proposal-rationale], [data-subject-edit], [data-send-answers], [data-proposal-reply], [data-subject-pending]",
    ),
  ).toBeNull();
  expect(c.textContent).not.toMatch(
    /skip|\bask\b|on your next message|\bEdit\b|Send \d/i,
  );

  // Before any answer the foot has Accept all, nothing filled.
  expect(foot(c).querySelector("[data-approve-rest]")!.textContent).toBe(
    "Accept all 2",
  );
  expect(
    foot(c).querySelector<HTMLElement>("[data-approve-rest]")!.style.background,
  ).toBe("");

  // One entry's Accept: one answer in the batch, naming the card, its changes, the number the person sees and the subject.
  click(
    c.querySelector("[data-subject='role:growth'] [data-subject-approve]")!,
  );
  expect(batch()).toEqual([
    ["role:growth", "approve", "", [2], ["c1-move"], 2, "Head of Growth"],
  ]);
  expect(root.backend.mutations).toEqual([]);
  const growth = () =>
    c.querySelector<HTMLElement>("[data-subject='role:growth']")!;
  expect(growth().getAttribute("data-subject-answer")).toBe("approve");
  expect(growth().getAttribute("data-subject-status")).toBe("proposed");
  expectAbsent(growth().querySelector("[data-subject-approve]"));
  expect(
    growth().querySelector("[data-staged]")!.getAttribute("data-staged"),
  ).toBe("approve");
  expect(growth().querySelector("[data-staged]")!.textContent).toBe(
    "Accepted. Applies when you send.Undo",
  );
  expect(foot(c).querySelector("[data-approve-rest]")!.textContent).toBe(
    "Accept the rest",
  );
  // Undo empties the batch and brings the controls back.
  click(growth().querySelector("[data-staged-undo]")!);
  expect(batch()).toEqual([]);
  expectAbsent(growth().querySelector("[data-staged]"));
  expectPresent(growth().querySelector("[data-subject-approve]"));
  expect(c.querySelector(".entity-card")!.getAttribute("aria-expanded")).toBe(
    "false",
  );
  await root.close();
});

test("Reject inside the Adjust field stages the band around the field; typing writes the body; Enter closes it and shows You; the frame never toggles", async () => {
  const root = await mount(inThread(card("op-1")));
  const c = q("[data-card='op-1']");
  const platform = () =>
    c.querySelector<HTMLElement>("[data-subject='role:platform']")!;
  expectAbsent(platform().querySelector("[data-subject-reject]"));
  click(platform().querySelector("[data-subject-reply]")!);
  expect(batch()).toEqual([]);
  click(
    platform().querySelector(
      "[data-subject-reply-field] [data-subject-reject]",
    )!,
  );
  expect(platform().querySelector("[data-staged]")!.textContent).toBe(
    "Rejected. Sent when you send.Undo",
  );
  const ta = platform().querySelector<HTMLTextAreaElement>(
    "[data-answer-area] [data-subject-reply-field] textarea",
  )!;
  expect(ta.placeholder).toBe("Why not? Say what you want instead.");
  type(ta, "Not yet");
  expect(batch()).toEqual([
    [
      "role:platform",
      "reject",
      "Not yet",
      [1],
      ["c1-role"],
      1,
      "Head of Platform",
    ],
  ]);
  // Typing never folds or opens the frame: a space and Enter stay in the field.
  const live = () =>
    platform().querySelector<HTMLTextAreaElement>(
      "[data-subject-reply-field] textarea",
    )!;
  expect(live().value).toBe("Not yet");
  key(live(), " ");
  expect(c.querySelector(".entity-card")!.getAttribute("aria-expanded")).toBe(
    "false",
  );
  key(live(), "Enter");
  expect(c.querySelector(".entity-card")!.getAttribute("aria-expanded")).toBe(
    "false",
  );
  expectAbsent(platform().querySelector("[data-subject-reply-field]"));
  expect(
    platform().querySelector("[data-staged] [data-subject-you]")!.textContent,
  ).toBe("You: Not yet");
  // Every card answered: nothing is left for "Accept the rest".
  click(
    c.querySelector("[data-subject='role:growth'] [data-subject-approve]")!,
  );
  expectAbsent(c.querySelector("[data-approve-rest]"));
  // Open, the card is the same ledger, reading the same batch.
  click(c.querySelector(".entity-card")!);
  expect(c.querySelector(".entity-card")!.getAttribute("aria-expanded")).toBe(
    "true",
  );
  const open = c.querySelector<HTMLElement>(".entity-card-expand")!;
  expect(sentences(open)).toEqual([
    "Add the role Head of Platform, reporting to you.",
    "Have Head of Growth report to Head of Platform.",
  ]);
  expect(
    open.querySelector("[data-subject='role:platform'] [data-subject-you]")!
      .textContent,
  ).toBe("You: Not yet");
  expect(
    open.querySelector("[data-subject='role:growth'] [data-staged='approve']"),
  ).not.toBeNull();
  expect(root.backend.mutations).toEqual([]);
  await root.close();
});

test("Accept all 2 with nothing answered, Accept the rest after one answer, pressed again withdraws only what it put; a word with a check", async () => {
  const root = await mount(inThread(card("op-1")));
  const c = q("[data-card='op-1']");
  const rest = () =>
    c.querySelector<HTMLElement>("[data-ledger-close] [data-approve-rest]")!;
  expect(rest().textContent).toBe("Accept all 2");
  // One card answered by hand first: Adjust, then Reject in its field.
  click(c.querySelector("[data-subject='role:growth'] [data-subject-reply]")!);
  click(c.querySelector("[data-subject='role:growth'] [data-subject-reject]")!);
  expect(rest().textContent).toBe("Accept the rest");
  // The rest holds a new role: the press opens the online review, and nothing is staged until it is confirmed.
  click(rest());
  expect(q("[data-switch-review]").getAttribute("data-switch-review")).toBe(
    "Bring @platform online",
  );
  expect(batch().map((b) => [b[0], b[1]])).toEqual([["role:growth", "reject"]]);
  await confirmOnline();
  expect(batch().map((b) => [b[0], b[1]])).toEqual([
    ["role:growth", "reject"],
    ["role:platform", "approve"],
  ]);
  expect(rest().getAttribute("aria-pressed")).toBe("true");
  expectPresent(rest().querySelector("svg"));
  expect(rest().style.background).toBe("");
  expect(rest().tagName).toBe("BUTTON");
  click(rest());
  expect(batch().map((b) => [b[0], b[1]])).toEqual([["role:growth", "reject"]]);
  expect(rest().getAttribute("aria-pressed")).toBe("false");
  expectAbsent(rest().querySelector("svg"));
  // With nothing answered it reads "Accept all 2" and answers both.
  click(c.querySelector("[data-subject='role:growth'] [data-staged-undo]")!);
  expect(batch()).toEqual([]);
  expect(rest().textContent).toBe("Accept all 2");
  click(rest());
  await confirmOnline();
  expect(batch().map((b) => [b[0], b[1]])).toEqual([
    ["role:platform", "approve"],
    ["role:growth", "approve"],
  ]);
  expect(qa("[data-staged='approve']").length).toBe(2);
  expect(root.backend.mutations).toEqual([]);
  await root.close();
});

test("after the send: no bands; accepted reads Accepted, applying, then applied reads Applied; the meta and the outcome say what happened", async () => {
  const landing = await mount(inThread(card("op-7")));
  const l = q("[data-card='op-7']");
  expect(
    l.querySelector(
      "[data-staged], [data-subject-approve], [data-approve-rest]",
    ),
  ).toBeNull();
  expect(
    Array.from(l.querySelectorAll("[data-subject-state]")).map((s) => [
      s.getAttribute("data-subject-state"),
      s.textContent,
    ]),
  ).toEqual([
    ["accepted", "Accepted, applying"],
    ["accepted", "Accepted, applying"],
  ]);
  expect(
    l.querySelector("[data-proposal-meta]")!.getAttribute("data-proposal-meta"),
  ).toBe("2 accepted");
  React.act(() =>
    useInboxStore.setState((s) => ({
      orgProposalChanges: {
        ...s.orgProposalChanges,
        "c7-role": {
          ...s.orgProposalChanges["c7-role"],
          status: "applied",
          applied_at: Date.now(),
        },
        "c7-move": {
          ...s.orgProposalChanges["c7-move"],
          status: "applied",
          applied_at: Date.now(),
        },
      },
    })),
  );
  expect(
    Array.from(l.querySelectorAll("[data-subject-state]")).map((s) => [
      s.getAttribute("data-subject-state"),
      s.textContent,
    ]),
  ).toEqual([
    ["applied", "Applied"],
    ["applied", "Applied"],
  ]);
  await landing.close();

  const root = await mount(card("op-2"));
  const c = q("[data-card='op-2']");
  expect(
    c.querySelector("[data-proposal-meta]")!.getAttribute("data-proposal-meta"),
  ).toBe("2 accepted");
  expect(
    c.querySelector(
      "[data-approve-rest], [data-send-answers], [data-proposal-reply], [data-staged]",
    ),
  ).toBeNull();
  expect(
    c.querySelector(
      "[data-subject-approve], [data-subject-reject], [data-subject-reply]",
    ),
  ).toBeNull();
  expect(c.querySelector("[data-proposal-outcome]")!.textContent).toBe(
    "2 accepted",
  );
  expect(subjects(c).map((s) => s.getAttribute("data-subject-status"))).toEqual(
    ["applied", "applied"],
  );
  // Nothing to answer, so no line asks the reader to open a thread.
  expectAbsent(c.querySelector("[data-proposal-readonly-line]"));
  await root.close();
});

test("a failed change keeps the card answerable: Adjust with Reject inside, and the note, never Retry; with no composer the card is read only", async () => {
  const root = await mount(inThread(card("op-3")));
  const c = q("[data-card='op-3']");
  expect(
    c.querySelector("[data-proposal-meta]")!.getAttribute("data-proposal-meta"),
  ).toBe("1 accepted, 1 failed");
  const meta = Array.from(
    c.querySelector("[data-proposal-meta]")!.children,
  ) as HTMLElement[];
  expect(meta.map((m) => m.textContent?.trim())).toEqual([
    "1 accepted, 1 failed",
    "fromHead of People",
  ]);
  const failed = () =>
    c.querySelector<HTMLElement>("[data-subject='role:platform']")!;
  expect(failed().getAttribute("data-subject-status")).toBe("failed");
  expect(failed().querySelector("[data-failed-note]")!.textContent).toBe(
    "Failed: A role already answers to @platform",
  );
  expectAbsent(failed().querySelector("[data-subject-approve]"));
  expectAbsent(failed().querySelector("[data-subject-reject]"));
  click(failed().querySelector("[data-subject-reply]")!);
  expect(
    failed().querySelector("[data-subject-reply-field] [data-subject-reject]"),
  ).not.toBeNull();
  key(
    failed().querySelector<HTMLElement>("[data-subject-reply-field] textarea")!,
    "Escape",
  );
  expect(batch()).toEqual([]);
  expect(root.backend.mutations).toEqual([]);
  await root.close();
  // No bridge at all (team chat drawing the proposal), or a bridge whose composer cannot send: nothing could carry an answer, so none is offered.
  for (const [name, ui] of [
    ["no bridge", card("op-3")],
    [
      "a bridge whose composer cannot send",
      h(
        ReviewComposerContext.Provider,
        { value: readOnlyComposer },
        card("op-3"),
      ),
    ],
  ] as const) {
    const r = await mount(ui);
    const ro = q("[data-card='op-3']");
    expect(
      ro.querySelector(
        "[data-subject-approve], [data-subject-reject], [data-subject-reply], [data-staged]",
      ),
      name,
    ).toBeNull();
    expect(
      ro.querySelector(
        "[data-approve-rest], [data-proposal-reply], [data-send-answers]",
      ),
      name,
    ).toBeNull();
    expect(ro.querySelector("[data-proposal-readonly]"), name).not.toBeNull();
    expect(
      ro.querySelector("[data-proposal-readonly-line]")!.textContent,
      name,
    ).toBe("Open this in Head of People's thread to answer.");
    expect(
      ro.querySelectorAll("[data-proposal-readonly-line]").length,
      name,
    ).toBe(1);
    expect(ro.querySelector("[data-failed-note]")!.textContent, name).toBe(
      "Failed: A role already answers to @platform",
    );
    expect(Object.keys(useInboxStore.getState().reviewComments), name).toEqual(
      [],
    );
    expect(r.backend.mutations).toEqual([]);
    await r.close();
  }
});

test("a limit never reaches the person: no row beside drawn changes, plain words when alone (S23.2)", async () => {
  const root = await mount(
    inThread(h("div", null, card("op-4"), card("op-5"))),
  );
  // Alone: one plain sentence naming the role, no unit, and the answers still apply.
  const alone = q("[data-card='op-4']");
  expect(sentences(alone)).toEqual([
    "Head of Growth keeps a safety net on its daily work.",
  ]);
  expectAbsent(alone.querySelector("[data-field]"));
  expect(alone.textContent).not.toMatch(/wakes|tokens|caps|limit/i);
  expect(
    alone
      .querySelector("[data-proposal-meta]")!
      .getAttribute("data-proposal-meta"),
  ).toBe("1 to decide");
  // One card is the whole decision: its Accept is the filled green face like any other, the body has no totals line, and the foot adds no "Accept the rest".
  expect(
    alone.querySelector<HTMLElement>("[data-subject-approve]")!.className,
  ).toContain("cc-btn-green");
  expect(
    alone.querySelector(
      "[data-approve-rest], [data-proposal-totals], [data-subject-ordinal]",
    ),
  ).toBeNull();
  click(alone.querySelector("[data-subject-approve]")!);
  expect(batch()).toEqual([
    ["role:growth", "approve", "", [1], ["c4-limit"], 1, "Head of Growth"],
  ]);
  // Beside a drawn change: nothing of it, no row, no words, and it is answered with the role it rides on.
  const beside = q("[data-card='op-5']");
  expect(
    subjects(beside).map((s) => [
      s.getAttribute("data-subject"),
      s.getAttribute("data-change-ids"),
    ]),
  ).toEqual([["role:platform", "c5-role c5-limit"]]);
  expect(beside.textContent).not.toMatch(/wakes|tokens|caps|limit|safety net/i);
  // A new role: its Accept opens the online review; Not yet stages nothing, the confirm stages it.
  click(beside.querySelector("[data-subject-approve]")!);
  expect(q("[data-switch-review]").textContent).toContain(
    "Accept and bring online",
  );
  click(q("[data-switch-cancel]"));
  expect(batch().length).toBe(1);
  click(beside.querySelector("[data-subject-approve]")!);
  await confirmOnline();
  expect(batch()[1]).toEqual([
    "role:platform",
    "approve",
    "",
    [1],
    ["c5-role", "c5-limit"],
    1,
    "Head of Platform",
  ]);
  expect(root.backend.mutations).toEqual([]);
  await root.close();
});

test("the summary heads the card: drawn whole in a card of its own, clamped to two lines in a tile; one entry beside it draws no Why row", async () => {
  const root = await mount(inThread(card("op-8")));
  const c = q("[data-card='op-8']");
  expect(
    c.querySelector("[data-proposal-letter], [data-letter-more]"),
  ).toBeNull();
  const summary = c.querySelector<HTMLElement>("[data-proposal-summary]")!;
  expect(summary.textContent).toContain(
    "Platform work is spread over four people",
  );
  expect(summary.textContent).toContain("names the sessions this would move");
  expect(summary.className).not.toContain("line-clamp-2");
  // One entry and a summary: the summary says why, so the entry carries no Why row.
  expect(c.querySelectorAll("[data-subject]").length).toBe(1);
  expectAbsent(c.querySelector("[data-subject-why]"));
  expect(c.textContent).not.toContain("Because c8-role.");
  await root.close();
  // A tile sharing a row: the summary clamped to two lines, and no entries.
  const tile = await mount(
    inThread(
      h(
        "div",
        { "data-card": "op-8" },
        h(EntityObjectCard, { refId: "op-8", count: 2 }),
      ),
    ),
  );
  const t = q("[data-card='op-8']");
  expect(t.querySelector("[data-proposal-summary]")!.className).toContain(
    "line-clamp-2",
  );
  expectAbsent(t.querySelector("[data-subject]"));
  await tile.close();
});

test("in a message, op-N#seq alone on its line is the proposal's pill, opening the screen with the change in focus, and never a card", async () => {
  const { default: ReactMarkdown } = await import("react-markdown");
  const { ASSISTANT_MD_REMARK, MESSAGE_MD_COMPONENTS } =
    await import("../messageMarkdown");
  const body =
    "Start with the one everything else waits on.\n\nop-1#2\n\nThen op-1#1 can follow.";
  const root = await mount(
    h(ReactMarkdown, {
      remarkPlugins: [...ASSISTANT_MD_REMARK],
      components: MESSAGE_MD_COMPONENTS,
      children: body,
    }),
  );
  expect(qa("[data-subject], [data-change-ref], [data-proposal-card]")).toEqual(
    [],
  );
  const pills = qa("a.entity-ref");
  expect(pills.map((p) => [p.textContent, p.getAttribute("href")])).toEqual([
    ["#2", "/org?proposal=op-1&focus=2"],
    ["#1", "/org?proposal=op-1&focus=1"],
  ]);
  expect(pills[0].closest(".entity-card-row")).not.toBeNull();
  expect(pills[1].closest("p")!.textContent).toBe("Then #1 can follow.");
  click(pills[0]);
  expect(root.navigationLog.at(-1)).toEqual({
    action: "push",
    path: "/org?proposal=op-1&focus=2",
  });
  await root.close();
});

test("the store's focus on a change marks its card; on the org screen the card lights the map and draws no Map word and no Open proposal link", async () => {
  const lit: (string | null)[] = [];
  const root = await mount(
    h(
      OrgHoverContext.Provider,
      { value: (id: string | null) => lit.push(id) },
      inThread(card("op-1")),
    ),
    "c1-move",
  );
  const c = q("[data-card='op-1']");
  expect(
    qa("[data-focused]").map((e) => e.getAttribute("data-subject")),
  ).toEqual(["role:growth"]);
  expectAbsent(c.querySelector("[data-open-map]"));
  // Nor an Open proposal link: the person is on the page it opens.
  expectAbsent(c.querySelector("a[title='Open proposal']"));
  React.act(() => {
    c.querySelector("[data-subject='role:platform']")!.dispatchEvent(
      new MouseEvent("mouseover", { bubbles: true }),
    );
  });
  expect(lit.splice(0)).toEqual(["c1-role"]);
  await root.close();
});

test("a revision landing on a staged card withdraws the answer: the batch empties and the controls come back under Revised since you last looked", async () => {
  const root = await mount(inThread(card("op-1")));
  const c = q("[data-card='op-1']");
  const platform = () =>
    c.querySelector<HTMLElement>("[data-subject='role:platform']")!;
  click(platform().querySelector("[data-subject-approve]")!);
  await confirmOnline();
  expect(batch().map((b) => b[0])).toEqual(["role:platform"]);
  expectPresent(platform().querySelector("[data-staged]"));
  const was = useInboxStore.getState().orgProposalChanges["c1-role"];
  React.act(() =>
    useInboxStore.setState((s) => ({
      orgProposalChanges: {
        ...s.orgProposalChanges,
        "c1-role": {
          ...was,
          revision: {
            kind: "amended",
            note: "Narrowed to the platform project.",
            at: Date.now() + 60_000,
          },
        },
      },
    })),
  );
  expect(batch()).toEqual([]);
  expectAbsent(platform().querySelector("[data-staged]"));
  expectPresent(platform().querySelector("[data-subject-approve]"));
  expect(platform().hasAttribute("data-revised-new")).toBe(true);
  expect(platform().textContent).toContain("Revised since you last looked");
  expect(platform().querySelector("[data-revision]")!.textContent).toContain(
    "Changed Narrowed to the platform project.",
  );
  expect(root.backend.mutations).toEqual([]);
  await root.close();
});

test("an op id the store has never seen is a loading card, then not available once served", async () => {
  const root = await mount(card("op-404"));
  const c = q("[data-card='op-404']");
  expect(c.textContent).not.toContain("Not available to you");
  expectPresent(c.querySelector('[aria-hidden="true"] .animate-pulse'));
  await React.act(async () => root.backend.set(api.orgProposals.get, null));
  expect(c.textContent).toContain("Not available to you");
  await root.close();
});
