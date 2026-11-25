import { afterEach, spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { api } from "@codecast/convex/convex/_generated/api";
import type { InitiativeRow } from "@codecast/goals/initiative";
import { act, Fragment, useState } from "react";
import { useInboxStore } from "../../store/inboxStore";
import { webBuilders } from "../../test-helpers/builders";
import { expectPresent } from "../../test-helpers/domExpect";
import { mountWeb } from "../../test-helpers/mountWeb";
import { pending } from "../../test-helpers/testConvex";
import { ORG_FIXTURE } from "../org/orgFixture";
import * as fx from "./initiativeFixture";
import { InitiativeRecord, Written } from "./InitiativeRecord";

const { teamMember } = webBuilders("InitiativeRecord.mount.test.tsx");
const viewer = teamMember.build({
  _id: "fixture-user-me" as ReturnType<typeof teamMember.build>["_id"],
  name: "Ashot",
});
const sam = teamMember.build({
  _id: "fixture-user-sam" as ReturnType<typeof teamMember.build>["_id"],
  name: "Sam",
});
const row = (id: string): InitiativeRow =>
  useInboxStore.getState().initiatives[id];
let restoreClock: (() => void) | undefined;
afterEach(() => {
  restoreClock?.();
  restoreClock = undefined;
});

test("the goal record mounts: parts in order, milestones marked, a question answered, a source read, why saved, nothing empty drawn", async () => {
  const q = <T extends Element = HTMLElement>(sel: string) =>
    document.querySelector<T>(sel);
  const qa = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
  const attrs = (sel: string, name: string) =>
    qa(sel).map((el) => el.getAttribute(name));
  const click = async (el: Element | null) => {
    assert.ok(el, "missing element");
    await act(async () => {
      (el as HTMLElement).click();
    });
  };
  const type = async (el: Element | null, value: string) => {
    assert.ok(el, "missing field");
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    await act(async () => {
      Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const press = async (
    el: Element | null,
    key: string,
    mods: { metaKey?: boolean; ctrlKey?: boolean } = {},
  ) => {
    assert.ok(el, "missing field");
    await act(async () => {
      el.dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          bubbles: true,
          cancelable: true,
          ...mods,
        }),
      );
    });
  };

  function Sheet({ id }: { id: string }) {
    const initiative = useInboxStore((store) => store.initiatives[id]);
    return (
      <Fragment key={id}>
        <Written
          initiative={initiative}
          field="why"
          label="Why"
          rows={4}
          markdown
          fallback={initiative.description}
          placeholder=""
        />
        <InitiativeRecord initiative={initiative} now={fx.FIXTURE_NOW} />
      </Fragment>
    );
  }
  const clock = spyOn(Date, "now").mockReturnValue(fx.FIXTURE_NOW);
  restoreClock = () => clock.mockRestore();
  const web = await mountWeb(<Sheet id="init-org" />, {
    dispatch: true,
    setup(backend, store) {
      store.syncTable("currentUser", viewer);
      store.syncTable("clientState", {
        ui: { active_team_id: "fixture-team" },
      });
      store.syncTable("orgTree", ORG_FIXTURE);
      store.syncTable("teamMembers", [
        { ...viewer, roster_team: "fixture-team" },
        { ...sam, roster_team: "fixture-team" },
      ]);
      store.syncTable("initiatives", fx.FIXTURE_INITIATIVES);
      backend.mutation(api.dispatch.dispatch, null);
      backend.set(api.org.roles, pending);
    },
  });
  let shown = "init-org";
  const paint = () => web.rerender(<Sheet id={shown} />);
  const mount = (id: string) => {
    shown = id;
    return paint();
  };
  const calls = () =>
    web.backend.mutations.flatMap(({ name, args }) => {
      if (name !== "dispatch:dispatch") return [];
      const {
        action,
        args: [id, payload],
      } = args as { action: string; args: [string, unknown] };
      if (action === "recordInitiativeEntry") return [{ action, id, payload }];
      if (action === "updateInitiative") return [{ action, id, payload }];
      return [];
    });
  const last = () => calls().at(-1)!;
  await mount("init-org");
  assert.deepEqual(
    attrs("[data-initiative-section]", "data-initiative-section"),
    ["why", "done_when", "milestones", "questions", "decisions", "sources"],
  );
  assert.match(
    q("[data-initiative-section='why'] div.prose")!.textContent!,
    /routing work that an agent could route/,
  );
  assert.match(
    q("[data-initiative-section='done_when']")!.textContent!,
    /Every project has a lead that is an agent/,
  );

  assert.deepEqual(
    attrs("[data-initiative-milestone-row]", "data-initiative-milestone-row"),
    [
      "org_chart_live",
      "roles_own_tasks",
      "scope_view_ships",
      "every_area_has_a_lead",
      "a_person_reads_one_page",
    ],
  );
  assert.deepEqual(
    attrs("[data-initiative-milestone-row]", "data-milestone-state"),
    ["reached", "reached", "late", "ahead", "ahead"],
  );
  assert.deepEqual(
    attrs("[data-milestone-next]", "data-initiative-milestone-row"),
    ["scope_view_ships"],
    "the first one not reached is the next, late or not",
  );
  assert.match(
    q(
      "[data-initiative-milestone-row='org_chart_live'] [data-initiative-milestone-date]",
    )!.textContent!,
    /^reached Aug 28$/,
  );
  assert.equal(
    q(
      "[data-initiative-milestone-row='org_chart_live'] [data-intent-source]",
    )!.getAttribute("data-intent-source"),
    "plan",
  );
  assert.match(
    q("[data-initiative-milestone-row='scope_view_ships']")!.textContent!,
    /overdue/,
  );
  assert.equal(
    q("[data-initiative-milestone-counts]")!.textContent,
    "2 of 5 reached",
  );

  await click(
    q(
      "[data-initiative-milestone-row='scope_view_ships'] [data-initiative-milestone-reach]",
    ),
  );
  assert.deepEqual(last(), {
    action: "recordInitiativeEntry",
    id: "init-org",
    payload: { list: "milestones", action: "close", key: "scope_view_ships" },
  });
  await paint();
  assert.deepEqual(
    attrs("[data-initiative-milestone-row]", "data-milestone-state"),
    ["reached", "reached", "reached", "next", "ahead"],
  );
  assert.deepEqual(
    attrs("[data-milestone-next]", "data-initiative-milestone-row"),
    ["every_area_has_a_lead"],
  );
  assert.equal(
    q("[data-initiative-milestone-counts]")!.textContent,
    "3 of 5 reached",
  );

  await click(q("[data-initiative-add='milestones']"));
  await type(
    q("[data-initiative-form='milestones'] [data-field='title']"),
    "Weekly review reads itself",
  );
  await type(
    q("[data-initiative-form='milestones'] [data-field='date']"),
    "2026-10-30",
  );
  await press(
    q("[data-initiative-form='milestones'] [data-field='title']"),
    "Enter",
  );
  assert.deepEqual(last(), {
    action: "recordInitiativeEntry",
    id: "init-org",
    payload: {
      list: "milestones",
      action: "add",
      entry: {
        title: "Weekly review reads itself",
        date: Date.UTC(2026, 9, 30, 23, 59, 59, 999),
      },
    },
  });
  await paint();
  assert.equal(
    q("[data-initiative-form='milestones']"),
    null,
    "the form closes",
  );
  assert.ok(q("[data-initiative-milestone-row='weekly_review_reads_itself']"));
  await click(
    q(
      "[data-initiative-milestone-row='weekly_review_reads_itself'] [data-initiative-remove]",
    ),
  );
  await paint();
  assert.equal(
    q("[data-initiative-milestone-row='weekly_review_reads_itself']"),
    null,
  );

  assert.deepEqual(
    attrs("[data-question-state='open']", "data-initiative-question"),
    ["who_leads_the_inbox_project", "does_the_review_run_weekly_or_daily"],
  );
  assert.ok(
    q(
      "[data-initiative-question='who_leads_the_inbox_project'] [title='Ashot']",
    ),
    "a name the roster knows wears its face",
  );
  assert.ok(
    q(
      "[data-initiative-question='does_the_review_run_weekly_or_daily'] [data-assignee-role='or-1']",
    ),
    "an @handle that is a role wears the role's",
  );
  assert.deepEqual(
    attrs(
      "[data-initiative-answered] [data-question-state='answered']",
      "data-initiative-question",
    ),
    ["do_agent_seats_bill_separately"],
  );
  assert.match(
    q("[data-initiative-answered] summary")!.textContent!,
    /1 answered/,
  );
  assert.match(
    q(
      "[data-initiative-question='do_agent_seats_bill_separately'] [data-initiative-answer]",
    )!.textContent!,
    /Billing has its own/,
  );

  await click(
    q(
      "[data-initiative-question='who_leads_the_inbox_project'] [data-initiative-answer-open]",
    ),
  );
  await type(
    q("[data-initiative-form='answer'] input"),
    "The growth lead, from Monday",
  );
  await click(
    q("[data-initiative-form='answer'] [data-initiative-form-submit]"),
  );
  assert.deepEqual(last(), {
    action: "recordInitiativeEntry",
    id: "init-org",
    payload: {
      list: "questions",
      action: "close",
      key: "who_leads_the_inbox_project",
      answer: "The growth lead, from Monday",
    },
  });
  await paint();
  assert.deepEqual(
    attrs("[data-question-state='open']", "data-initiative-question"),
    ["does_the_review_run_weekly_or_daily"],
  );
  assert.equal(
    q("[data-initiative-question='who_leads_the_inbox_project']")!.getAttribute(
      "data-question-state",
    ),
    "answered",
  );
  assert.match(
    q(
      "[data-initiative-question='who_leads_the_inbox_project'] [data-initiative-answer]",
    )!.textContent!,
    /The growth lead, from Monday/,
  );
  assert.match(
    q("[data-initiative-answered] summary")!.textContent!,
    /2 answered/,
  );

  assert.deepEqual(
    attrs("[data-initiative-decision]", "data-initiative-decision"),
    ["the_head_of_people_is_the_root_seat", "roles_are_colleagues"],
  );
  const newest = q(
    "[data-initiative-decision='the_head_of_people_is_the_root_seat']",
  )!;
  assert.ok(newest.querySelector("[title='Ashot']"));
  assert.match(newest.textContent!, /Sep 4/);
  assert.equal(
    newest
      .querySelector("[data-intent-source]")!
      .getAttribute("data-intent-source"),
    "call",
  );
  assert.match(newest.querySelector("a")!.getAttribute("href")!, /cl-42/);

  assert.deepEqual(
    attrs("[data-initiative-source]", "data-initiative-source"),
    [
      "call:cl-42:15",
      "note:agents should run the routine work by the end of the year.",
    ],
  );
  assert.match(
    q(
      "[data-initiative-source='call:cl-42:15'] [data-initiative-source-quote]",
    )!.textContent!,
    /I read one page/,
  );
  const callSource = q("[data-initiative-source='call:cl-42:15']")!;
  assert.ok(
    callSource.querySelector("[data-initiative-by='face'] [title='Ashot']"),
  );
  assert.equal(
    callSource.querySelector("[data-intent-source]")!.textContent,
    "Call cl-42, line 15",
  );
  assert.match(callSource.textContent!, /Aug 21/);
  const noteSource = q("[data-initiative-source^='note:']")!;
  assert.ok(noteSource.querySelector("[title='Sam']"));
  assert.equal(noteSource.querySelector("[data-intent-source]"), null);
  assert.doesNotMatch(noteSource.textContent!, /Note/);
  assert.match(
    noteSource.querySelector("[data-initiative-source-quote]")!.textContent!,
    /Agents should run the routine work/,
  );
  await click(q("[data-initiative-add='sources']"));
  await type(
    q("[data-initiative-form='sources'] [data-field='text']"),
    "ct-12 said so",
  );
  await type(q("[data-initiative-form='sources'] [data-field='by']"), "Sam");
  await click(
    q("[data-initiative-form='sources'] [data-initiative-form-submit]"),
  );
  assert.deepEqual(last(), {
    action: "recordInitiativeEntry",
    id: "init-org",
    payload: {
      list: "sources",
      action: "add",
      entry: { text: "ct-12 said so", by: "Sam" },
    },
  });
  await paint();
  const added = q("[data-initiative-source='task:ct-12']")!;
  assert.ok(added, "read as a task");
  assert.equal(
    added
      .querySelector("[data-intent-source]")!
      .getAttribute("data-intent-source"),
    "task",
  );
  assert.equal(
    added.querySelector("[data-initiative-source-quote]")!.textContent,
    "said so",
  );
  assert.deepEqual(row("init-org").sources![2], {
    by: "Sam",
    kind: "task",
    quote: "said so",
    ref: "ct-12",
  });

  const withSource = () =>
    row("init-org").milestones!.find((m) => m.key === "org_chart_live")!;
  await click(
    q(
      "[data-initiative-milestone-row='org_chart_live'] [data-initiative-edit-entry]",
    ),
  );
  const editTitle = q<HTMLInputElement>(
    "[data-initiative-form='edit-milestones'] [data-field='title']",
  )!;
  assert.equal(
    editTitle.value,
    "Org chart live",
    "the form opens on the entry's own words",
  );
  assert.equal(
    q<HTMLInputElement>(
      "[data-initiative-form='edit-milestones'] [data-field='date']",
    )!.value,
    "2026-08-29",
    "and its own day",
  );
  await type(
    q("[data-initiative-form='edit-milestones'] [data-field='date']"),
    "2026-11-15",
  );
  await press(editTitle, "Enter");
  assert.deepEqual(
    last(),
    {
      action: "recordInitiativeEntry",
      id: "init-org",
      payload: {
        list: "milestones",
        action: "edit",
        key: "org_chart_live",
        entry: { date: Date.UTC(2026, 10, 15, 23, 59, 59, 999) },
      },
    },
    "only what changed is sent",
  );
  await paint();
  assert.equal(
    q("[data-initiative-form='edit-milestones']"),
    null,
    "the form closes",
  );
  assert.deepEqual(
    { ...withSource(), done_at: 0 },
    {
      date: Date.UTC(2026, 10, 15, 23, 59, 59, 999),
      done_at: 0,
      key: "org_chart_live",
      source: { kind: "plan", ref: "pl-600" },
      title: "Org chart live",
    },
  );
  let writes = calls().length;
  await click(
    q(
      "[data-initiative-milestone-row='org_chart_live'] [data-initiative-edit-entry]",
    ),
  );
  await type(
    q("[data-initiative-form='edit-milestones'] [data-field='title']"),
    "Something else",
  );
  await press(
    q("[data-initiative-form='edit-milestones'] [data-field='title']"),
    "Escape",
  );
  assert.equal(q("[data-initiative-form='edit-milestones']"), null);
  await click(
    q(
      "[data-initiative-milestone-row='org_chart_live'] [data-initiative-edit-entry]",
    ),
  );
  await press(
    q("[data-initiative-form='edit-milestones'] [data-field='title']"),
    "Enter",
  );
  assert.equal(
    calls().length,
    writes,
    "neither Escape nor an unchanged save writes",
  );
  await click(
    q(
      "[data-initiative-milestone-row='org_chart_live'] [data-initiative-edit-entry]",
    ),
  );
  await type(
    q("[data-initiative-form='edit-milestones'] [data-field='title']"),
    "The org chart is live",
  );
  await type(
    q("[data-initiative-form='edit-milestones'] [data-field='date']"),
    "",
  );
  await click(
    q("[data-initiative-form='edit-milestones'] [data-initiative-form-submit]"),
  );
  assert.deepEqual(last(), {
    action: "recordInitiativeEntry",
    id: "init-org",
    payload: {
      list: "milestones",
      action: "edit",
      key: "org_chart_live",
      entry: { title: "The org chart is live", date: null },
    },
  });
  await paint();
  assert.equal(withSource().date, undefined);
  assert.match(
    q("[data-initiative-milestone-row='org_chart_live']")!.textContent!,
    /The org chart is live/,
  );
  await click(
    q(
      "[data-initiative-question='does_the_review_run_weekly_or_daily'] [data-initiative-edit-entry]",
    ),
  );
  assert.equal(
    q<HTMLInputElement>(
      "[data-initiative-form='edit-questions'] [data-field='text']",
    )!.value,
    "Does the review run weekly or daily?",
  );
  await type(
    q("[data-initiative-form='edit-questions'] [data-field='text']"),
    "Does the review run weekly?",
  );
  await press(
    q("[data-initiative-form='edit-questions'] [data-field='text']"),
    "Enter",
  );
  assert.deepEqual(last(), {
    action: "recordInitiativeEntry",
    id: "init-org",
    payload: {
      list: "questions",
      action: "edit",
      key: "does_the_review_run_weekly_or_daily",
      entry: { text: "Does the review run weekly?" },
    },
  });
  await paint();
  const reworded = q(
    "[data-initiative-question='does_the_review_run_weekly_or_daily']",
  )!;
  assert.match(reworded.textContent!, /Does the review run weekly\?/);
  assert.ok(
    reworded.querySelector("[data-assignee-role='or-1']"),
    "who asked it stays",
  );
  assert.equal(
    reworded
      .querySelector("[data-intent-source]")!
      .getAttribute("data-intent-source"),
    "session",
    "and so does where",
  );
  await click(
    q(
      "[data-initiative-question='do_agent_seats_bill_separately'] [data-initiative-edit-entry]",
    ),
  );
  assert.equal(
    q<HTMLInputElement>(
      "[data-initiative-form='edit-questions'] [data-field='answer']",
    )!.value,
    "Not in this goal. Billing has its own.",
  );
  await type(
    q("[data-initiative-form='edit-questions'] [data-field='answer']"),
    "Billing has its own goal.",
  );
  await press(
    q("[data-initiative-form='edit-questions'] [data-field='answer']"),
    "Enter",
  );
  assert.deepEqual(last(), {
    action: "recordInitiativeEntry",
    id: "init-org",
    payload: {
      list: "questions",
      action: "edit",
      key: "do_agent_seats_bill_separately",
      entry: { answer: "Billing has its own goal." },
    },
  });
  await paint();
  assert.equal(
    q(
      "[data-initiative-question='do_agent_seats_bill_separately'] [data-initiative-answer]",
    )!.textContent,
    "Billing has its own goal.",
  );
  await click(
    q(
      "[data-initiative-decision='roles_are_colleagues'] [data-initiative-edit-entry]",
    ),
  );
  await type(
    q("[data-initiative-form='edit-decisions'] [data-field='text']"),
    "Roles are colleagues.",
  );
  await press(
    q("[data-initiative-form='edit-decisions'] [data-field='text']"),
    "Enter",
  );
  assert.deepEqual(last(), {
    action: "recordInitiativeEntry",
    id: "init-org",
    payload: {
      list: "decisions",
      action: "edit",
      key: "roles_are_colleagues",
      entry: { text: "Roles are colleagues." },
    },
  });
  await paint();
  const editedDecision = q("[data-initiative-decision='roles_are_colleagues']");
  expectPresent(editedDecision);
  assert.match(editedDecision.textContent!, /Roles are colleagues\./);
  assert.match(
    editedDecision.querySelector("[data-initiative-by=face]")!.textContent!,
    /Head of Growth/,
  );
  await click(
    q("[data-initiative-source='call:cl-42:15'] [data-initiative-edit-entry]"),
  );
  assert.equal(
    q<HTMLInputElement>(
      "[data-initiative-form='edit-sources'] [data-field='text']",
    )!.value,
    "call:cl-42:15 Every area should have a lead that is an agent, and I read one page.",
  );
  await type(
    q("[data-initiative-form='edit-sources'] [data-field='by']"),
    "Sam",
  );
  await press(
    q("[data-initiative-form='edit-sources'] [data-field='by']"),
    "Enter",
  );
  await paint();
  assert.deepEqual(row("init-org").sources![0], {
    at: fx.FIXTURE_NOW - 28 * 86_400_000,
    by: "Sam",
    kind: "call",
    quote:
      "Every area should have a lead that is an agent, and I read one page.",
    ref: "cl-42:15",
  });
  assert.ok(q("[data-initiative-source='call:cl-42:15'] [title='Sam']"));
  await click(q("[data-initiative-add='decisions']"));
  await type(
    q("[data-initiative-form='decisions'] [data-field='text']"),
    "Brokers go first",
  );
  await type(
    q("[data-initiative-form='decisions'] [data-field='source']"),
    "on the Monday standup",
  );
  await click(
    q("[data-initiative-form='decisions'] [data-initiative-form-submit]"),
  );
  await paint();
  assert.equal(
    q(
      "[data-initiative-decision='brokers_go_first'] [data-intent-source='note']",
    )!.textContent,
    "on the Monday standup",
  );

  await click(q("[data-initiative-edit='why']"));
  await type(
    q("[data-initiative-field='why']"),
    "A draft about the first goal",
  );
  await click(q("[data-initiative-add='milestones']"));
  await type(
    q("[data-initiative-form='milestones'] [data-field='title']"),
    "A milestone of the first goal",
  );
  await click(q("[data-initiative-add='questions']"));
  await click(q("[data-initiative-add='sources']"));
  writes = calls().length;
  shown = "init-org-sub";
  await paint();
  assert.equal(
    q("[data-initiative-record]")!.getAttribute("data-initiative-record"),
    "in-2",
  );
  assert.equal(
    q("[data-initiative-field='why']"),
    null,
    "the first goal's draft is not open on the second",
  );
  assert.deepEqual(
    attrs("[data-initiative-form]", "data-initiative-form"),
    [],
    "nor is any of its forms",
  );
  assert.equal(
    document.body.textContent!.includes("A draft about the first goal"),
    false,
  );
  await click(q("[data-initiative-edit='why']"));
  assert.equal(
    q<HTMLTextAreaElement>("[data-initiative-field='why']")!.value,
    row("init-org-sub").why ?? "",
  );
  await type(q("[data-initiative-field='why']"), "Why the second goal matters");
  await press(q("[data-initiative-field='why']"), "Enter", { metaKey: true });
  assert.deepEqual(last(), {
    action: "updateInitiative",
    id: "init-org-sub",
    payload: { why: "Why the second goal matters" },
  });
  assert.equal(
    calls().length,
    writes + 1,
    "and nothing was written to the first",
  );
  shown = "init-org";
  await paint();

  await click(q("[data-initiative-edit='why']"));
  await type(
    q("[data-initiative-field='why']"),
    "  Because a person should read one page.  ",
  );
  await press(q("[data-initiative-field='why']"), "Enter", { metaKey: true });
  assert.deepEqual(last(), {
    action: "updateInitiative",
    id: "init-org",
    payload: { why: "Because a person should read one page." },
  });
  await paint();
  assert.equal(q("[data-initiative-field='why']"), null, "the editor closes");
  assert.equal(
    q("[data-initiative-section='why'] div.prose")!.textContent,
    "Because a person should read one page.",
  );
  const before = calls().length;
  await click(q("[data-initiative-edit='done_when']"));
  await type(q("[data-initiative-field='done_when']"), "Something else");
  await press(q("[data-initiative-field='done_when']"), "Escape");
  assert.equal(q("[data-initiative-field='done_when']"), null);
  assert.equal(calls().length, before, "Escape writes nothing");
  await click(q("[data-initiative-edit='done_when']"));
  await type(q("[data-initiative-field='done_when']"), "   ");
  await press(q("[data-initiative-field='done_when']"), "Enter", {
    ctrlKey: true,
  });
  assert.deepEqual(last(), {
    action: "updateInitiative",
    id: "init-org",
    payload: { done_when: null },
  });

  await mount("init-orphan");
  assert.deepEqual(
    attrs("[data-initiative-section]", "data-initiative-section"),
    ["why"],
    "Why with the word that writes it, and nothing else",
  );
  assert.match(
    q("[data-initiative-section='why']")!.textContent!,
    /^Why\s*Write$/,
  );
  assert.deepEqual(
    attrs("[data-initiative-add-part]", "data-initiative-add-part"),
    ["done_when", "milestones", "questions", "decisions", "sources"],
  );
  assert.doesNotMatch(
    document.body.textContent!,
    /Nobody|No milestones|Nothing is waiting|No decisions/,
  );
  assert.equal(
    document.querySelectorAll("p.italic, .italic").length,
    0,
    "no column of italics",
  );
  assert.equal(q("[data-initiative-answered]"), null);
  assert.equal(q("[data-initiative-milestone-counts]"), null);
  await click(q("[data-initiative-add-part='milestones']"));
  assert.deepEqual(
    attrs("[data-initiative-section]", "data-initiative-section"),
    ["why", "milestones"],
  );
  assert.ok(q("[data-initiative-form='milestones']"), "the form is open");
  assert.deepEqual(
    attrs("[data-initiative-add-part]", "data-initiative-add-part"),
    ["done_when", "questions", "decisions", "sources"],
  );
  await act(async () =>
    web.store.getState().syncRecord("initiatives", "init-orphan", {
      ...row("init-orphan"),
      description: "Phones do what the desktop does.",
    }),
  );
  await paint();
  assert.equal(
    q("[data-initiative-section='why'] div.prose")!.textContent,
    "Phones do what the desktop does.",
  );
  await click(q("[data-initiative-edit='why']"));
  await type(
    q("[data-initiative-field='why']"),
    "Half the team reads on a phone.",
  );
  await press(q("[data-initiative-field='why']"), "Enter", { metaKey: true });
  assert.deepEqual(last(), {
    action: "updateInitiative",
    id: "init-orphan",
    payload: { why: "Half the team reads on a phone." },
  });

  let runs = 800;
  function Capped() {
    const initiative = useInboxStore((store) => store.initiatives["init-org"]);
    return (
      <Written
        initiative={initiative}
        field="why"
        label="Why"
        rows={4}
        markdown
        clamp
        placeholder=""
      />
    );
  }
  const proto = window.HTMLElement.prototype;
  Object.defineProperty(proto, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.parentElement?.hasAttribute("data-clamped") ? runs : 0;
    },
  });
  let version = 0;
  const capped = () => web.rerender(<Capped key={++version} />);
  await capped();
  assert.equal(q("[data-clamped]")!.getAttribute("data-clamped"), "cut");
  assert.equal(q("[data-clamp-toggle]")!.textContent, "Read all");
  await click(q("[data-clamp-toggle]"));
  assert.equal(
    q("[data-clamped]")!.getAttribute("data-clamped"),
    "open",
    "Read all lifts the cap",
  );
  assert.equal(q("[data-clamp-toggle]")!.textContent, "Show less");
  assert.ok(
    q("[data-initiative-edit='why']"),
    "Edit stays in the section head",
  );
  runs = 0;
  await capped();
  assert.equal(q("[data-clamped]")!.getAttribute("data-clamped"), "whole");
  assert.equal(q("[data-clamp-toggle]"), null, "words that fit get no toggle");
  Reflect.deleteProperty(proto, "scrollHeight");
});
