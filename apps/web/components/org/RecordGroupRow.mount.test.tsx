import { expect, spyOn, test } from "bun:test";
import { api } from "@codecast/convex/convex/_generated/api";
import React, { act } from "react";
import { batchSendWords } from "../../lib/reviewActions";
import { useInboxStore } from "../../store/inboxStore";
import { flushSyncPublishes } from "../../store/syncTransaction";
import { webBuilders } from "../../test-helpers/builders";
import { expectAbsent, expectPresent } from "../../test-helpers/domExpect";
import { mountWeb } from "../../test-helpers/mountWeb";
import { pending } from "../../test-helpers/testConvex";
import { EntityObjectCard } from "../EntityObjectCard";
import { ReviewComposerContext } from "../reviewContext";
import {
  ORG_RECORDS_FIXTURE_PROPOSAL,
  ORG_RECORDS_FIXTURE_PROPOSAL_BARE,
  ORG_RECORDS_FIXTURE_PROPOSAL_SENT,
  ORG_RECORDS_FIXTURE_TREE,
} from "./orgRecordsFixture";
import type { OrgProposalRow } from "./orgStaffingTypes";

const h = React.createElement;
const tasksOf = (
  p: OrgProposalRow,
  id: string,
  short_id: string,
  count?: number,
): OrgProposalRow => {
  const tasks = p.changes
    .filter((c) => c.change.kind === "task_status")
    .slice(0, count);
  return {
    ...p,
    _id: id,
    short_id,
    changes: tasks.map((c, i) => ({
      ...c,
      _id: `${id}-${i + 1}`,
      proposal_id: id,
      seq: i + 1,
    })),
  };
};
const LONE = tasksOf(
  ORG_RECORDS_FIXTURE_PROPOSAL_BARE,
  "fixture-proposal-904",
  "op-904",
);
const PAGED = tasksOf(
  ORG_RECORDS_FIXTURE_PROPOSAL_BARE,
  "fixture-proposal-905",
  "op-905",
  23,
);

const BARE: OrgProposalRow = {
  ...ORG_RECORDS_FIXTURE_PROPOSAL_BARE,
  short_id: "op-9011",
};
const SENT: OrgProposalRow = {
  ...ORG_RECORDS_FIXTURE_PROPOSAL_SENT,
  short_id: "op-9012",
};
const FAILED_ONLY: OrgProposalRow = {
  ...SENT,
  _id: "failed-only-proposal",
  short_id: "op-9013",
  changes: SENT.changes
    .filter((row) => row.status === "failed")
    .map((row) => ({ ...row, _id: `failed-only-${row.seq}` })),
};
const { conversation } = webBuilders("RecordGroupRow.mount.test.tsx");
const CONV = conversation.build()._id;
const composer = {
  quote() {},
  submit() {},
  populate() {},
  conversationId: CONV,
  canSend: true,
  send: () => {},
};
const reviewComments = () =>
  useInboxStore.getState().reviewComments[CONV] ?? [];
const batch = () =>
  reviewComments().map(({ proposal, body }) => {
    if (!proposal) throw new Error("Expected a proposal answer");
    return [
      proposal.card,
      proposal.verdict,
      body,
      proposal.seqs.length,
      proposal.change_ids.length,
      proposal.subject,
    ];
  });
const clearBatch = () =>
  act(() => useInboxStore.getState().clearReviewComments(CONV));

function mount(ui: React.ReactNode, focusId?: string) {
  return mountWeb(ui, {
    setup(backend, store) {
      backend.set(api.orgProposals.get, pending);
      backend.set(api.orgProposals.list, pending);
      backend.set(api.org.tree, pending);
      backend.set(api.org.roles, pending);
      backend.set(api.plans.webGet, pending);
      backend.set(api.tasks.webGet, pending);
      store.syncTable("orgTree", ORG_RECORDS_FIXTURE_TREE);
      const proposals = [
        ORG_RECORDS_FIXTURE_PROPOSAL,
        BARE,
        SENT,
        FAILED_ONLY,
        LONE,
        PAGED,
        MIXED,
      ];
      store.syncTable(
        "orgProposals",
        proposals.map(({ changes: _changes, ...row }) => row),
      );
      store.syncTable(
        "orgProposalChanges",
        proposals.flatMap((row) =>
          row.changes.map((change) => ({ ...change, proposal_id: row._id })),
        ),
      );
      if (focusId) store.setOrgFocusChangeId(focusId);
    },
  });
}

const card = (ref: string) =>
  h("div", { "data-card": ref }, h(EntityObjectCard, { refId: ref, count: 1 }));
const inThread = (ui: React.ReactNode) =>
  h(ReviewComposerContext.Provider, { value: composer }, ui);
const q = (sel: string) => document.querySelector<HTMLElement>(sel)!;
const click = (el: HTMLElement) =>
  act(() => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const key = (el: HTMLElement, k: string) =>
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  });
const type = (el: HTMLTextAreaElement, text: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
const groups = (c: HTMLElement) =>
  Array.from(c.querySelectorAll<HTMLElement>("[data-subject-kind='group']"));
const group = (c: HTMLElement, key: string) =>
  c.querySelector<HTMLElement>(`[data-subject='group:${key}']`)!;

const TABLE = [
  [
    "project:pr-901",
    "Matching Engine & Funnel",
    "project",
    "20",
    "1 plan done, 2 plans abandoned, 14 tasks done and 3 tasks reopened",
  ],
  [
    "project:pr-902",
    "Callers & Call Management",
    "project",
    "18",
    "2 plans done, 1 plan abandoned, 12 tasks done, 1 task dropped and 2 tasks reopened",
  ],
  [
    "project:pr-903",
    "Infrastructure",
    "project",
    "9",
    "1 plan done, 6 tasks done and 2 tasks reopened",
  ],
  [
    "plan:pl-911",
    "Counterparty pitches",
    "plan",
    "6",
    "1 plan done and 5 tasks done",
  ],
  [
    "plan:pl-912",
    "Networks",
    "plan",
    "5",
    "1 plan reopened and 4 tasks reopened",
  ],
  [
    "loose",
    "Not under a project",
    null,
    "6",
    "2 tasks done, 3 tasks reopened and 1 task to the backlog",
  ],
];

test("op-901 draws six group rows in order, each titled and totalled, all closed; the card carries the proposal's totals", async () => {
  const root = await mount(inThread(card("op-901")));
  const c = q("[data-card='op-901']");
  expect(
    c.querySelector("[data-proposal-card]")!.getAttribute("data-proposal-work"),
  ).toBe("records");
  expect(
    c.querySelector("[data-proposal-meta]")!.getAttribute("data-proposal-meta"),
  ).toMatch(/^64 records to decide/);
  expect(c.querySelector("[data-proposal-totals]")!.textContent).toBe(
    "64 records: 44 done, 15 reopened, 3 abandoned, 1 dropped and 1 to the backlog.",
  );
  expect(
    groups(c).map((g) => [
      g.getAttribute("data-subject")!.replace(/^group:/, ""),
      g.querySelector("[data-group-toggle] span")!.textContent,
      g.querySelector("[data-group-toggle] span + span")?.textContent ?? null,
      g.getAttribute("data-group-count"),
      g.querySelector("[data-group-totals]")!.textContent,
    ]),
  ).toEqual(TABLE);
  expect(c.querySelectorAll("[data-subject-kind]").length).toBe(6);
  expectAbsent(c.querySelector("[data-group-rows]"));
  expect(
    groups(c).every(
      (g) =>
        g
          .querySelector("[data-group-toggle]")!
          .getAttribute("aria-expanded") === "false",
    ),
  ).toBe(true);
  expect(
    groups(c).every(
      (g) =>
        g.querySelector("[data-subject-approve]") &&
        g.querySelector("[data-subject-reply]"),
    ),
  ).toBe(true);

  expectAbsent(c.querySelector("[data-subject-reject]"));
  expect(
    groups(c).map(
      (g) => g.querySelector("[data-subject-verdicts]")!.textContent,
    ),
  ).toEqual(TABLE.map(() => "AdjustAccept"));

  expect(
    groups(c).every((g) =>
      g
        .querySelector("[data-subject-approve]")!
        .className.includes("cc-btn-green"),
    ),
  ).toBe(true);
  expect(c.querySelector("[data-approve-rest]")!.textContent).toBe(
    "Accept all 6",
  );
  expect(
    c.querySelector(
      "[data-send-answers], [data-proposal-reply], [data-subject-pending]",
    ),
  ).toBeNull();
  expect(c.textContent).not.toMatch(
    /on your next message|Filed under no project/,
  );
  await root.close();
});

test("Accept on a group stages one answer over every record in it, named by the group; the band replaces the controls; Undo clears", async () => {
  const root = await mount(inThread(card("op-901")));
  const c = q("[data-card='op-901']");
  const a = () => group(c, "project:pr-901");
  click(a().querySelector("[data-subject-approve]")!);
  expect(batch()).toEqual([
    ["group:project:pr-901", "approve", "", 20, 20, "Matching Engine & Funnel"],
  ]);
  expect(root.backend.mutations).toEqual([]);
  expect(a().getAttribute("data-subject-answer")).toBe("approve");
  expect(a().querySelector("[data-staged]")!.textContent).toBe(
    "Accepted. Applies when you send.Undo",
  );
  expectAbsent(a().querySelector("[data-subject-approve]"));
  expect(c.querySelector("[data-approve-rest]")!.textContent).toBe(
    "Accept the rest",
  );
  click(a().querySelector("[data-staged-undo]")!);
  expect(batch()).toEqual([]);
  expectAbsent(a().querySelector("[data-staged]"));
  expectPresent(a().querySelector("[data-subject-approve]"));
  await root.close();
});

test("Accept all 6 stages every group, reads pressed with a check, and pressed again takes them all back", async () => {
  const root = await mount(inThread(card("op-901")));
  const c = q("[data-card='op-901']");
  const rest = () => c.querySelector<HTMLElement>("[data-approve-rest]")!;
  click(rest());
  expect(batch().map((b) => [b[0], b[1]])).toEqual(
    TABLE.map((row) => [`group:${row[0]}`, "approve"]),
  );
  expect(rest().getAttribute("aria-pressed")).toBe("true");
  expectPresent(rest().querySelector("svg"));

  expect(rest().style.background).toBe("");
  expect(
    groups(c).every((g) => g.querySelector("[data-staged='approve']")),
  ).toBe(true);
  click(rest());
  expect(batch()).toEqual([]);
  expect(rest().textContent).toBe("Accept all 6");
  expect(root.backend.mutations).toEqual([]);
  await root.close();
});

test("Adjust on a group opens the field; Reject in it asks the group's why; the words and Enter stage a rejection with them", async () => {
  const root = await mount(inThread(card("op-901")));
  const c = q("[data-card='op-901']");
  const b = () => group(c, "project:pr-902");
  click(b().querySelector("[data-subject-reply]")!);
  expect(batch()).toEqual([]);
  click(b().querySelector("[data-subject-reply-field] [data-subject-reject]")!);
  const ta = b().querySelector<HTMLTextAreaElement>(
    "[data-subject-reply-field] textarea",
  )!;
  expect(ta.placeholder).toBe(
    "Why not? Say which records to leave out, by number, or what to change.",
  );
  type(ta, "Leave #20 out");
  expect(batch()).toEqual([
    [
      "group:project:pr-902",
      "reject",
      "Leave #20 out",
      18,
      18,
      "Callers & Call Management",
    ],
  ]);
  key(ta, "Enter");
  expectAbsent(b().querySelector("[data-subject-reply-field]"));
  expect(b().querySelector("[data-staged]")!.textContent).toBe(
    "Rejected. Sent when you send.UndoYou: Leave #20 out",
  );
  expect(
    b().querySelector("[data-subject-you]")!.getAttribute("data-subject-you"),
  ).toBe("reject");

  click(group(c, "plan:pl-911").querySelector("[data-subject-reply]")!);
  expect(
    group(c, "plan:pl-911").querySelector<HTMLTextAreaElement>(
      "[data-subject-reply-field] textarea",
    )!.placeholder,
  ).toBe("Say something about these records");
  expect(c.querySelector(".entity-card")!.getAttribute("aria-expanded")).toBe(
    "false",
  );
  await root.close();
});

test("open, a group lists its records as pills and the status each becomes, never struck, with no controls; past twenty, Show N more", async () => {
  const root = await mount(inThread(card("op-901")));
  const c = q("[data-card='op-901']");
  const a = () => group(c, "project:pr-901");
  click(a().querySelector("[data-group-toggle]")!);
  expect(
    a().querySelector("[data-group-toggle]")!.getAttribute("aria-expanded"),
  ).toBe("true");
  const rows = () =>
    Array.from(a().querySelectorAll<HTMLElement>("[data-record-row]"));
  expect(
    a().querySelector("[data-group-rows]")!.getAttribute("data-group-rows"),
  ).toBe("20");
  expect(rows().map((r) => r.getAttribute("data-record-row"))).toEqual(
    Array.from({ length: 20 }, (_, i) => String(i + 1)),
  );
  expect(rows()[0].querySelector("[data-record-seq]")!.textContent).toBe("#1");

  expect(rows()[0].querySelector("p")?.textContent).toBe(
    "Funnel stages v2→becomesDone",
  );
  expect(rows()[0].querySelector("p [data-subject-pill]")!.textContent).toBe(
    "Funnel stages v2",
  );
  expect(rows()[0].querySelector("p [data-diff=added]")!.textContent).toBe(
    "Done",
  );
  expect(rows().filter((r) => /line-through/.test(r.innerHTML))).toEqual([]);

  expect(a().textContent).not.toContain("the health sweep flagged it once");
  expect(
    a().querySelector(
      "[data-record-row] [data-subject-approve], [data-record-row] [data-subject-reject], [data-record-row] [data-subject-reply]",
    ),
  ).toBeNull();
  expectAbsent(a().querySelector("[data-group-more]"));
  click(a().querySelector("[data-group-toggle]")!);
  expectAbsent(a().querySelector("[data-group-rows]"));
  await root.close();

  const paged = await mount(inThread(card("op-905")));
  const p = q("[data-card='op-905']");
  expect(groups(p).length).toBe(1);
  click(p.querySelector("[data-group-show]")!);
  expect(p.querySelectorAll("[data-record-row]").length).toBe(20);
  const more = p.querySelector<HTMLElement>("[data-group-more]")!;
  expect(more.getAttribute("data-group-more")).toBe("3");
  expect(more.textContent).toBe("Show 3 more");
  click(more);
  expect(p.querySelectorAll("[data-record-row]").length).toBe(23);
  expectAbsent(p.querySelector("[data-group-more]"));
  await paged.close();
});

test("a proposal whose records all fall in one loose group is All N records, carrying the proposal's totals, closed with Show the N records", async () => {
  const root = await mount(inThread(card("op-904")));
  const c = q("[data-card='op-904']");
  expect(groups(c).length).toBe(1);
  const g = groups(c)[0];
  expect(g.querySelector("[data-group-toggle] span")!.textContent).toBe(
    "All 55 records",
  );
  expectAbsent(g.querySelector("[data-group-toggle] span + span"));
  expect(g.querySelector("[data-group-totals]")!.textContent).toBe(
    "55 records: 39 done, 14 reopened, 1 dropped and 1 to the backlog.",
  );
  expectAbsent(c.querySelector("[data-proposal-totals]"));
  expect(
    g.querySelector("[data-group-toggle]")!.getAttribute("aria-expanded"),
  ).toBe("false");
  expect(g.querySelector("[data-group-show]")!.textContent).toBe(
    "Show the 55 records",
  );

  expectAbsent(c.querySelector("[data-approve-rest]"));
  expect(
    c.querySelector("[data-proposal-meta]")!.getAttribute("data-proposal-meta"),
  ).toBe("55 records to decide");
  await root.close();

  const bare = await mount(inThread(card(BARE.short_id)));
  const b = q(`[data-card='${BARE.short_id}']`);
  expect(
    groups(b).map((g) => [
      g.getAttribute("data-subject"),
      g.querySelector("[data-group-toggle] span")!.textContent,
      g.querySelector("[data-group-toggle] span + span")?.textContent ?? null,
      g.getAttribute("data-group-count"),
    ]),
  ).toEqual([
    ["group:plans", "9 plans", null, "9"],
    ["group:loose", "Not under a project", null, "55"],
  ]);
  expect(
    group(b, "plans").querySelector("[data-group-totals]")!.textContent,
  ).toBe("5 plans done, 3 plans abandoned and 1 plan reopened");
  await bare.close();
});

test("after the send: Applied, Applying 10 of 18, Rejected with the words, 2 failed, answerable only where a composer can send, never Retry", async () => {
  const sent = SENT.short_id;
  for (const [name, ui, answerable] of [
    ["no composer", card(sent), false],
    ["a composer", inThread(card(sent)), true],
  ] as const) {
    const root = await mount(ui);
    const c = q(`[data-card='${sent}']`);
    const word = (key: string) =>
      group(c, key).querySelector("[data-subject-state]");
    expect(word("project:pr-901")!.textContent, name).toBe("Applied");
    expect(
      word("project:pr-901")!.getAttribute("data-subject-state"),
      name,
    ).toBe("applied");
    expect(word("project:pr-902")!.textContent, name).toBe("Applying 10 of 18");
    expect(
      word("project:pr-902")!.getAttribute("data-subject-state"),
      name,
    ).toBe("accepted");
    expect(word("project:pr-903")!.textContent, name).toBe("Rejected");
    expect(
      group(c, "project:pr-903").querySelector("[data-subject-you]")!
        .textContent,
      name,
    ).toBe("You: Not yet");
    expect(word("plan:pl-911")!.textContent, name).toBe("2 failed");
    expect(
      group(c, "project:pr-901").querySelector("[data-subject-approve]"),
      name,
    ).toBeNull();
    const p1 = group(c, "plan:pl-911");
    if (answerable) {
      expect(
        p1.querySelector("[data-subject-approve]")!.textContent,
        name,
      ).toBe("Accept");
      expect(p1.querySelector("[data-subject-reply]"), name).not.toBeNull();
      expect(c.querySelector("[data-proposal-readonly]"), name).toBeNull();
    } else {
      expect(
        p1.querySelector("[data-subject-approve], [data-subject-reply]"),
        name,
      ).toBeNull();
      expect(c.querySelector("[data-proposal-readonly]"), name).not.toBeNull();
      expect(
        c.querySelector("[data-proposal-readonly-line]")!.textContent,
        name,
      ).toBe("Open this in Head of People's thread to answer.");
    }
    expect(c.querySelector("[data-staged]"), name).toBeNull();

    const meta = c.querySelector("[data-proposal-meta]")!;
    expect(meta.getAttribute("data-proposal-meta"), name).toBe(
      "15 of 64 records to decide · 30 applied, 8 accepted, 9 rejected, 2 failed",
    );
    expect(
      Array.from(meta.querySelectorAll("span")).find(
        (s) => s.textContent === "2 failed",
      )!.className,
      name,
    ).toContain("--ink-red");

    click(p1.querySelector("[data-group-toggle]")!);
    expect(
      Array.from(p1.querySelectorAll("[data-record-row]"))
        .slice(0, 2)
        .map((r) => r.querySelector("[data-failed-note]")!.textContent),
      name,
    ).toEqual([
      "Failed: pl-911 is already done",
      "Failed: pl-911 is already done",
    ]);
    expect(
      p1.querySelectorAll("[data-record-row='50'] [data-failed-note]").length,
      name,
    ).toBe(0);
    expect(root.backend.mutations).toEqual([]);
    await root.close();
  }
});

test("the store's focus on a record opens the group holding it and marks the row", async () => {
  const root = await mount(inThread(card("op-901")), "fixture-records-40");
  const c = q("[data-card='op-901']");
  const g = group(c, "project:pr-903");
  expect(g.hasAttribute("data-focused")).toBe(true);
  expect(
    g.querySelector("[data-group-toggle]")!.getAttribute("aria-expanded"),
  ).toBe("true");
  expect(
    g.querySelector("[data-record-row='40']")!.hasAttribute("data-focused"),
  ).toBe(true);
  expect(c.querySelectorAll("[data-group-rows]").length).toBe(1);
  expect(c.querySelectorAll("[data-focused]").length).toBe(2);
  await root.close();
});

const MIXED: OrgProposalRow = (() => {
  const id = "fixture-proposal-906";
  return {
    ...ORG_RECORDS_FIXTURE_PROPOSAL,
    _id: id,
    short_id: "op-906",
    changes: ORG_RECORDS_FIXTURE_PROPOSAL.changes.map((c) => ({
      ...c,
      _id: `${id}-${c.seq}`,
      proposal_id: id,
      ...(c.seq >= 21 && c.seq <= 35
        ? { status: "applied" as const, decided_at: 1, applied_at: 1 }
        : {}),
    })),
  };
})();
test("Accept on a group part way landed stages only the records that wait (3 of 18), so the send's button and words count and name them alone", async () => {
  const root = await mount(inThread(card("op-906")));
  const c = q("[data-card='op-906']");
  const g = group(c, "project:pr-902");
  expect(g.getAttribute("data-group-count")).toBe("18");
  click(g.querySelector("[data-subject-approve]")!);
  expect(batch()).toEqual([
    ["group:project:pr-902", "approve", "", 3, 3, "Callers & Call Management"],
  ]);
  const staged = reviewComments();
  expect(staged[0].proposal?.seqs).toEqual([36, 37, 38]);
  expect(staged[0].proposal?.change_ids).toEqual([
    "fixture-proposal-906-36",
    "fixture-proposal-906-37",
    "fixture-proposal-906-38",
  ]);
  expect(
    staged[0].proposal?.change_ids.every(
      (id: string) =>
        useInboxStore.getState().orgProposalChanges[id].status === "proposed",
    ),
  ).toBe(true);
  expect(batchSendWords(staged)).toMatchObject({
    applies: 3,
    button: "Send and apply 3",
    head: "3 changes will apply when you send",
  });
  clearBatch();

  click(c.querySelector("[data-approve-rest]")!);
  expect(
    batchSendWords(useInboxStore.getState().reviewComments[CONV]).applies,
  ).toBe(64 - 15);
  clearBatch();
  await root.close();
  expect(root.backend.mutations).toEqual([]);
});

test("a revision landing on a staged group withdraws the answer: the batch empties and the controls come back under Revised since you last looked", async () => {
  const root = await mount(inThread(card("op-901")));
  const c = q("[data-card='op-901']");
  const g = () => group(c, "project:pr-903");
  click(g().querySelector("[data-subject-approve]")!);
  expect(batch().map((b) => b[0])).toEqual(["group:project:pr-903"]);
  expectPresent(g().querySelector("[data-staged]"));
  expect(g().hasAttribute("data-revised-new")).toBe(false);
  const was = useInboxStore.getState().orgProposalChanges["fixture-records-39"];
  const revisionAt = reviewComments()[0].createdAt + 1;
  await act(async () => {
    useInboxStore.getState().syncTable("orgProposalChanges", [
      {
        ...was,
        revision: {
          kind: "amended",
          note: "Kept the warm pool.",
          at: revisionAt,
        },
      },
    ]);
    flushSyncPublishes();
  });
  expect(batch()).toEqual([]);
  expectAbsent(g().querySelector("[data-staged]"));
  expectPresent(g().querySelector("[data-subject-approve]"));
  expect(g().hasAttribute("data-revised-new")).toBe(true);
  expect(g().textContent).toContain("Revised since you last looked");

  const clock = spyOn(Date, "now").mockReturnValue(revisionAt + 1);
  try {
    click(g().querySelector("[data-subject-approve]")!);
    expect(g().hasAttribute("data-revised-new")).toBe(false);
  } finally {
    clock.mockRestore();
  }
  expect(root.backend.mutations).toEqual([]);
  await root.close();
});

test("a group with only failed records offers Adjust but cannot be accepted", async () => {
  const root = await mount(inThread(card(FAILED_ONLY.short_id)));
  const failed = group(
    q(`[data-card='${FAILED_ONLY.short_id}']`),
    "plan:pl-911",
  );
  expectPresent(failed);
  expect(failed.querySelector("[data-subject-state]")?.textContent).toBe(
    "2 failed",
  );
  expectPresent(failed.querySelector("[data-subject-reply]"));
  expectAbsent(failed.querySelector("[data-subject-approve]"));
  expect(root.backend.mutations).toEqual([]);
  await root.close();
});
