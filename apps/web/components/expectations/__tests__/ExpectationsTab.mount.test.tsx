import { expect, test } from "bun:test";
import { api } from "@codecast/convex/convex/_generated/api";
import type {
  Expectation,
  ExpectationCitation,
} from "@codecast/line/expectations";
import { act, type ReactElement } from "react";
import type { ExpectationsOverviewRow } from "../../../hooks/useSyncExpectationsOverview";
import type { ProjectExpectationsRow } from "../../../hooks/useSyncProjectExpectations";
import { webBuilders } from "../../../test-helpers/builders";
import { expectAbsent, expectPresent } from "../../../test-helpers/domExpect";
import { mountWeb } from "../../../test-helpers/mountWeb";
import { pending, type testConvex } from "../../../test-helpers/testConvex";
import { ExpectationsOverview } from "../ExpectationsOverview";
import { ExpectationsTab } from "../ExpectationsTab";

const ids = webBuilders("ExpectationsTab.mount.test.tsx");
const TEAM = ids.teamMember.build()._id;
const viewer = ids.teamMember.build({ name: "Ashot" });
const project = ids.project.build({
  title: "Callers",
  short_id: "pj-4",
  workspace: "team:" + TEAM,
});
const PID = project._id;
const CALL: ExpectationCitation = {
  kind: "call",
  ref: "cl-96:718",
  quote: "a call card's facts should hold true",
  when: "2026-09-30",
};
const line = (
  n: number,
  text: string,
  part: string,
  over: Partial<Expectation> = {},
): Expectation => ({
  id: `ex-callers-call-${n}`,
  text,
  part,
  status: "active",
  citations: [CALL],
  added_in: 1,
  changed_in: 1,
  ...over,
});
const finding = (n: number, days: number) => ({
  short_id: `sg-${n}`,
  title: `Card said the wrong broker (${n})`,
  kind: "prompt_miss",
  source: "judge",
  created_at: Date.now() - days * 86_400_000,
  cause: { id: "c1", short_id: "ct-512", title: "Card facts", status: "open" },
});
const row = (
  over: Partial<ProjectExpectationsRow> = {},
): ProjectExpectationsRow => ({
  _id: PID,
  project: { id: PID, title: "Callers" },
  current_version: 2,
  doc: {
    project: { id: PID, title: "Callers" },
    version: 2,
    prefix: "callers-call",
    next_n: 5,
    how: "person",
    summary: "Seed",
    applied_at: Date.UTC(2026, 9, 3),
    applied_by: "Ashot",
    items: [
      line(1, "A call card's facts are true.", "Calls"),
      line(
        2,
        "Callbacks happen only when the contact asked for one.",
        "Calls",
        { note: "Does a voicemail count as asking?" },
      ),
      line(3, "An intro goes out within a day.", "Intros"),
    ],
  },
  versions: [
    {
      version: 2,
      summary: "Ashot added: an intro goes out within a day",
      how: "person",
      applied_at: Date.UTC(2026, 9, 3),
      applied_by: "Ashot",
      active: 3,
      added: 1,
      changed: 0,
      retired: 0,
      proposal: "xp-3",
      proposed_by: "Ashot",
    },
    {
      version: 1,
      summary: "From the Sep 30 call",
      how: "auto",
      applied_at: Date.UTC(2026, 9, 1),
      applied_by: "Ashot",
      active: 2,
      added: 2,
      changed: 0,
      retired: 0,
      proposal: "xp-1",
      proposed_by: "Ashot",
      from_session: true,
    },
  ],
  proposals: [
    {
      short_id: "xp-7",
      status: "open",
      summary: "From the Oct 4 call",
      changes: 1,
      base_version: 2,
      created_at: Date.now() - 3_600_000,
      proposed_by: "Ashot",
      from_session: true,
      ops: [
        {
          op: "add",
          part: "Calls",
          text: "The card names the broker.",
          citations: [
            {
              kind: "call",
              ref: "cl-99:12",
              quote: "it should name the broker on the card",
              when: "2026-10-04",
            },
          ],
        },
      ],
    },
    {
      short_id: "xp-2",
      status: "dropped",
      summary: "Too broad",
      changes: 1,
      base_version: 1,
      created_at: Date.UTC(2026, 9, 2),
      resolved_at: Date.UTC(2026, 9, 2),
    },
  ],
  cursor: null,
  you_answer: true,
  person: "Ashot",
  usage: {
    since: 0,
    lines: {
      "ex-callers-call-1": {
        d7: 2,
        d30: 3,
        last_at: Date.now(),
        findings: [finding(1, 1), finding(2, 3), finding(3, 12)],
      },
    },
  },
  sources: {
    "call:cl-96:718": { who: "Ashot" },
    "call:cl-99:12": { who: "Cam" },
  },
  routine: null,
  ...over,
});

function mount(
  el: ReactElement,
  opts: {
    record?: ProjectExpectationsRow;
    overview?: ExpectationsOverviewRow[];
  } = {},
) {
  return mountWeb(el, {
    path: opts.overview
      ? "/expectations"
      : "/projects/" + PID + "?tab=expectations",
    dispatch: true,
    setup(backend, store) {
      store.syncTable("currentUser", viewer);
      store.syncTable("clientState", { ui: { active_team_id: TEAM } });
      store.syncTable("teamMembers", [{ ...viewer, roster_team: TEAM }]);
      store.syncTable("projects", [project]);
      store.syncTable("projectExpectations", [opts.record ?? row()]);
      if (opts.overview) store.syncTable("expectationsOverview", opts.overview);
      backend.set(api.expectations.forProject, pending);
      backend.set(api.expectations.overview, pending);
      backend.set(api.projects.webList, pending);
      backend.set(api.transcripts.webGetCallRef, pending);
      backend.set(api.tasks.webGet, pending);
      backend.mutation(api.dispatch.dispatch, null);
    },
  });
}

const writes = (backend: ReturnType<typeof testConvex>) =>
  backend.mutations.flatMap(({ name, args }) => {
    if (name !== "dispatch:dispatch") return [];
    const dispatch = args as { action: string; args: unknown[] };
    return [[dispatch.action, ...dispatch.args]];
  });

const click = async (el: HTMLElement | Element | null) => {
  expectPresent(el);
  await act(async () =>
    el.dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );
};
function setValue(el: Element | null, value: string) {
  expectPresent(el);
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}
const submit = async (form: Element | null) => {
  expectPresent(form);
  await act(async () =>
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    ),
  );
};
const text = (el: Element | null | undefined) =>
  el?.textContent?.replace(/\s+/g, " ").trim() ?? "";

test("the header says what an expectation is and where the document stands; proposals lead", async () => {
  const {
    container: host,
    close: done,
    backend,
  } = await mount(<ExpectationsTab projectId={PID} />);
  expect(text(host.querySelector("[data-expectations-about]"))).toContain(
    "Plain sentences about how the product should behave",
  );
  expect(text(host.querySelector("[data-expectations-stat='Lines']"))).toBe(
    "Lines3in 2 areas",
  );
  expect(
    text(host.querySelector("[data-expectations-stat='Broken in 30 days']")),
  ).toBe("Broken in 30 days12 breaks this week");
  expect(
    text(host.querySelector("[data-expectations-stat='Never cited']")),
  ).toContain("2");
  expect(
    text(host.querySelector("[data-expectations-stat='Version']")),
  ).toContain("1 waiting");
  const order = [
    ...host.querySelectorAll(
      "[data-expectation-proposals], [data-expectations-lines]",
    ),
  ].map((el) =>
    (el as HTMLElement).hasAttribute("data-expectation-proposals")
      ? "proposals"
      : "lines",
  );
  expect(order).toEqual(["proposals", "lines"]);
  const p = host.querySelector("[data-expectation-proposal='xp-7']")!;
  expect(text(p)).toContain("Not asked yet");
  expect(text(p)).not.toContain("Ashot's session");
  expect(
    (p.querySelector("[data-expectation-open]") as HTMLElement).title,
  ).toContain("Ashot's session");
  await click(p.querySelector("[data-expectation-open='xp-7']"));
  expect(text(p.querySelector("[data-citation-who]"))).toBe("Cam");
  await click(p.querySelector("[data-expectation-apply='xp-7']"));
  expect(writes(backend)).toEqual([
    ["resolveExpectationProposal", PID, "xp-7", "apply"],
  ]);
  expect(host.textContent).not.toContain("cast ");
  await done();
}, 30_000);

test("each source is a quote with who said it, where and when", async () => {
  const { container: host, close: done } = await mount(
    <ExpectationsTab projectId={PID} />,
  );
  const first = host.querySelector(
    "[data-expectation='ex-callers-call-1'] [data-citation-line]",
  )!;
  expect(text(first.querySelector("[data-citation-quote]"))).toBe(
    "a call card's facts should hold true",
  );
  expect(text(first.querySelector("[data-citation-who]"))).toBe("Ashot");
  expect(text(first.querySelector("[data-citation-when]"))).toBe("Sep 30");
  await done();
}, 30_000);

test("usage: a broken line opens to its findings and causes; a quiet one says it never fired", async () => {
  const { container: host, close: done } = await mount(
    <ExpectationsTab projectId={PID} />,
  );
  const broken = host.querySelector("[data-expectation='ex-callers-call-1']")!;
  const usage = broken.querySelector("[data-expectation-usage]") as HTMLElement;
  expect(usage.dataset.expectationUsage).toBe("week");
  expect(text(usage)).toBe("3breaks, 30 days2 this week");
  expect(
    text(
      host.querySelector(
        "[data-expectation='ex-callers-call-3'] [data-expectation-usage]",
      ),
    ),
  ).toBe("never cited");
  await click(usage);
  const findings = broken.querySelectorAll("[data-expectation-finding]");
  expect(findings.length).toBe(3);
  expect(text(findings[0])).toContain("Card said the wrong broker (1)");
  expect(
    broken.querySelectorAll(
      "[data-expectation-causes] [data-pill], [data-expectation-causes] a, [data-expectation-causes] span",
    ).length,
  ).toBeGreaterThan(0);
  await done();
}, 30_000);

test("filters narrow to broken, never cited and contested lines", async () => {
  const { container: host, close: done } = await mount(
    <ExpectationsTab projectId={PID} />,
  );
  const ids = () =>
    [
      ...host.querySelectorAll("[data-expectations-lines] [data-expectation]"),
    ].map((el) => (el as HTMLElement).dataset.expectation);
  expect(text(host.querySelector("[data-expectations-filter='quiet']"))).toBe(
    "Never cited2",
  );
  await click(host.querySelector("[data-expectations-filter='broken']"));
  expect(ids()).toEqual(["ex-callers-call-1"]);
  await click(host.querySelector("[data-expectations-filter='questions']"));
  expect(ids()).toEqual(["ex-callers-call-2"]);
  await click(host.querySelector("[data-expectations-filter='quiet']"));
  expect(ids()).toEqual(["ex-callers-call-2", "ex-callers-call-3"]);
  await done();
}, 30_000);

test("a line is changed in place, and a contested line's question is settled with how", async () => {
  const {
    container: host,
    close: done,
    backend,
  } = await mount(<ExpectationsTab projectId={PID} />);
  await click(
    host.querySelector("[data-expectation-edit='ex-callers-call-1']"),
  );
  const form = host.querySelector("[data-expectation-edit-form]")!;
  expect(text(form.querySelector("[data-expectation-edit-submit]"))).toBe(
    "Save",
  );
  await act(async () => {
    setValue(
      form.querySelector("[data-expectation-edit-text]"),
      "A call card's facts are true for every caller.",
    );
  });
  await submit(form);
  expect(writes(backend)[0]).toEqual([
    "editExpectations",
    PID,
    {
      op: "edit",
      id: "ex-callers-call-1",
      text: "A call card's facts are true for every caller.",
    },
  ]);

  await click(
    host.querySelector("[data-expectation-settle='ex-callers-call-2']"),
  );
  const settle = host.querySelector("[data-expectation-settle-form]")!;
  await act(async () => {
    setValue(
      settle.querySelector("[data-expectation-settle-why]"),
      "A voicemail asking for a call counts, ruled on the Oct 6 call",
    );
  });
  await submit(settle);
  expect(writes(backend)[1]).toEqual([
    "editExpectations",
    PID,
    {
      op: "edit",
      id: "ex-callers-call-2",
      note: "",
      why: "A voicemail asking for a call counts, ruled on the Oct 6 call",
    },
  ]);
  await done();
}, 30_000);

test("adding a line with a source names what kind of source it is", async () => {
  const {
    container: host,
    close: done,
    backend,
  } = await mount(<ExpectationsTab projectId={PID} />);
  await click(host.querySelector("[data-expectations-add]"));
  const form = host.querySelector("[data-expectation-add-form]")!;
  await act(async () => {
    setValue(
      form.querySelector("[data-expectation-text]"),
      "Every callback names who asked for it.",
    );
  });
  await act(async () => {
    setValue(form.querySelector("[data-expectation-source]"), "ct-512");
  });
  expect(
    (form.querySelector("[data-expectation-source-detail]") as HTMLElement)
      .dataset.expectationSourceDetail,
  ).toBe("task");
  await act(async () => {
    setValue(
      form.querySelector("[data-expectation-source-quote]"),
      "say who asked",
    );
  });
  await submit(form);
  expect(writes(backend)[0]).toEqual([
    "editExpectations",
    PID,
    {
      op: "add",
      text: "Every callback names who asked for it.",
      part: "Calls",
      source: { kind: "task", ref: "ct-512", quote: "say who asked" },
    },
  ]);
  await done();
}, 30_000);

test("history: each version with how it landed, and a dropped proposal", async () => {
  const { container: host, close: done } = await mount(
    <ExpectationsTab projectId={PID} />,
  );
  const entries = [
    ...host.querySelectorAll("[data-expectations-history-entry]"),
  ].map((el) => (el as HTMLElement).dataset.expectationsHistoryEntry);
  expect(entries).toEqual(["v2", "closed", "v1"]);
  expect(
    text(
      host.querySelector(
        "[data-expectations-history-entry='v1'] [data-expectations-history-how]",
      ),
    ),
  ).toBe(
    "Applied on its own: every line it added quotes words a person said, from xp-1 proposed by Ashot's session",
  );
  expect(
    text(host.querySelector("[data-expectations-history-entry='v2']")),
  ).toContain("1 added");
  await done();
}, 30_000);

test("a project with no expectations explains them and offers both ways to start", async () => {
  const { container: host, close: done } = await mount(
    <ExpectationsTab projectId={PID} />,
    {
      record: row({
        doc: null,
        current_version: 0,
        versions: [],
        proposals: [],
        usage: { since: 0, lines: {} },
      }),
    },
  );
  const first = host.querySelector("[data-expectations-first-run]")!;
  expect(text(first)).toContain("Write down how Callers should behave");
  expect(text(first)).toContain("An expectation is one plain sentence");
  expect(text(first.querySelector("[data-expectations-draft]"))).toBe(
    "Draft from recent context",
  );
  await click(first.querySelector("[data-expectations-write-first]"));
  expectAbsent(host.querySelector("[data-expectations-first-run]"));
  expectPresent(host.querySelector("[data-expectation-add-form]"));
  expect(host.textContent).not.toContain("cast ");
  await done();
}, 30_000);

test("the overview: what waits and what breaks first, projects without a document after", async () => {
  const r = (id: string, title: string, over: Record<string, unknown>) => ({
    _id: id,
    workspace: `team:${TEAM}`,
    project: { id, short_id: `pj-${id}`, title },
    version: 2,
    applied_at: Date.UTC(2026, 9, 3),
    active: 4,
    retired: 0,
    parts: 2,
    open_proposals: 0,
    breaks7: 0,
    breaks30: 0,
    broken: 0,
    most_broken: [],
    ...over,
  });
  const overview = [
    r("a", "Agent Quality", {
      breaks30: 7,
      breaks7: 2,
      broken: 1,
      most_broken: [
        {
          id: "ex-agent-quality-3",
          text: "A reply names the broker.",
          part: "Replies",
          d7: 2,
          d30: 7,
        },
      ],
    }),
    r("b", "Billing", {}),
    r("c", "Callers", { open_proposals: 2 }),
    r("d", "Docs site", {
      version: 0,
      active: 0,
      parts: 0,
      applied_at: null,
    }),
    {
      ...r("e", "Other workspace", { open_proposals: 100 }),
      workspace: "team:other",
    },
  ];
  const { container: host, close: done } = await mount(
    <ExpectationsOverview />,
    { overview },
  );
  const docs = [...host.querySelectorAll("[data-expectations-document]")].map(
    (el) => (el as HTMLElement).dataset.expectationsDocument,
  );
  expect(docs).toEqual(["pj-c", "pj-a", "pj-b"]);
  expect(
    text(host.querySelector("[data-expectations-document='pj-a']")),
  ).toContain("A reply names the broker.");
  expect(
    host.querySelector(
      "[data-expectations-document='pj-a'] a[href='/projects/pj-a?tab=expectations#ex-agent-quality-3']",
    ),
  ).toBeTruthy();
  expect(text(host.querySelector("[data-expectations-waiting]"))).toBe(
    "2 waiting",
  );
  expect(
    host
      .querySelector("[data-expectations-start='pj-d']")
      ?.getAttribute("href"),
  ).toBe("/projects/pj-d?tab=expectations");
  await done();
}, 30_000);
