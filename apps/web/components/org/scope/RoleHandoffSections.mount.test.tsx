import { api } from "@codecast/convex/convex/_generated/api";
import { afterEach, spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { mountWeb } from "../../../test-helpers/mountWeb";
import { pending } from "../../../test-helpers/testConvex";
import { waitForPopupClose } from "../../../test-helpers/waitForPopupClose";
import { ORG_FIXTURE } from "../orgFixture";
import type { OrgRole, OrgTree } from "../orgTypes";
import {
  HandingOverSection,
  MergeStepSwitch,
  SplitRoleSection,
  SuccessionSection,
  mergeStepWords,
  splitReadiness,
} from "./RoleHandoffSections";

let restoreClock: (() => void) | undefined;
afterEach(() => {
  restoreClock?.();
  restoreClock = undefined;
});

async function verify() {
  const now = Date.UTC(2026, 10, 24, 18);
  const clock = spyOn(Date, "now").mockReturnValue(now);
  restoreClock = () => clock.mockRestore();
  const base = ORG_FIXTURE;
  // The fixture holds one role; a second lead stands in as the other side of
  // a handoff and a succession.
  const second: OrgRole = {
    ...base.roles[0],
    _id: "org_roles_ads",
    short_id: "or-99",
    handle: "ads",
    name: "Ads lead",
    scope_names: {
      projects: [{ id: "projects_ads", title: "Ads" }],
      plans: [],
    },
  };
  const tree: OrgTree = { ...base, roles: [...base.roles, second] };
  const web = await mountWeb(null, {
    path: "/org/or-1",
    dispatch: true,
    setup(backend, store) {
      store.syncTable("currentUser", { _id: "fixture-user-me" });
      store.syncTable("clientState", {
        ui: { active_team_id: tree.workspace.id },
      });
      store.syncTable("orgTree", tree);
      backend.set(api.org.roles, pending);
      backend.mutation(api.dispatch.dispatch, ({ action }) =>
        action === "splitOrgRole"
          ? {
              roles: [{ handle: "growth-a" }, { handle: "growth-b" }],
              handoff: { deadline: now + 86_400_000 },
            }
          : {},
      );
    },
  });
  let read = 0;
  const calls = () =>
    web.backend.mutations.slice(read).map(({ name, args }) => {
      assert.equal(name, "dispatch:dispatch");
      assert.ok(
        args &&
          typeof args === "object" &&
          !Array.isArray(args) &&
          !(args instanceof ArrayBuffer),
      );
      return { action: args.action, args: args.args };
    });
  const takeCall = () => {
    const all = calls();
    assert.equal(all.length, 1);
    read++;
    return all[0];
  };
  const q = <T extends Element = HTMLElement>(sel: string) =>
    document.querySelector<T>(sel);
  const qa = <T extends Element = HTMLElement>(sel: string) => [
    ...document.querySelectorAll<T>(sel),
  ];
  const text = () => document.body.textContent ?? "";
  const render = web.rerender;

  const growth = tree.roles.find(
    (r) => r.handle !== "head-of-people" && r.status === "active",
  )!;
  const other =
    tree.roles.find((r) => r._id !== growth._id && r.status !== "retired") ??
    tree.roles.find((r) => r._id !== growth._id)!;

  // ── the merge switch: off by default, says so; on without a grant asks for the limit and writes it in one act ──
  assert.equal(mergeStepWords(null), "Reading the flow");
  assert.match(
    mergeStepWords({
      on: false,
      allowed: false,
      reason: "merge is off",
      used: 0,
      limit: null,
    }),
    /left for a person/,
  );
  assert.match(
    mergeStepWords({
      on: true,
      allowed: true,
      reason: null,
      used: 1,
      limit: 3,
    }),
    /1 of 3 today/,
  );
  assert.match(
    mergeStepWords({
      on: true,
      allowed: false,
      reason: "the role's merge authority has expired",
      used: 0,
      limit: 3,
    }),
    /not now: the role's merge authority has expired/,
  );
  await render(
    React.createElement(MergeStepSwitch, {
      role: growth,
      canEdit: true,
      merge: {
        on: false,
        allowed: false,
        reason: "merge is off for this line",
        used: 0,
        limit: null,
      },
    }),
  );
  assert.equal(q("[data-merge-step]")!.getAttribute("data-merge-step"), "off");
  await act(async () => {
    q<HTMLButtonElement>("[role=switch]")!.click();
  });
  assert.ok(
    q("[data-merge-limit-form]"),
    "no grant yet: the switch asks for a daily limit first",
  );
  assert.equal(calls().length, 0);
  assert.equal(
    q<HTMLInputElement>("[data-merge-limit-form] input[type=number]")!.value,
    "3",
    "a sensible default limit is filled in",
  );
  await act(async () => {
    q<HTMLButtonElement>(
      "[data-merge-limit-form] button[type=submit]",
    )!.click();
  });
  assert.deepEqual(takeCall(), {
    action: "setOrgLineMerge",
    args: [growth._id, true, 3],
  });
  // With a grant already held, the switch opens the review of what merging on its own means, and the review's own button turns it on; off is one click.
  await render(
    React.createElement(MergeStepSwitch, {
      role: growth,
      canEdit: true,
      merge: {
        on: false,
        allowed: false,
        reason: "merge is off for this line",
        used: 0,
        limit: 3,
      },
    }),
  );
  await act(async () => {
    q<HTMLButtonElement>("[role=switch]")!.click();
  });
  assert.equal(calls().length, 0, "the switch alone turns nothing on");
  assert.equal(q('[data-switch-figure="merges a day, max"]')!.textContent, "3");
  await act(async () => {
    q<HTMLButtonElement>("[data-switch-confirm]")!.click();
  });
  await waitForPopupClose();
  assert.deepEqual(takeCall(), {
    action: "setOrgLineMerge",
    args: [growth._id, true, null],
  });
  await render(
    React.createElement(MergeStepSwitch, {
      role: { ...growth, line_merge: true },
      canEdit: true,
      merge: { on: true, allowed: true, reason: null, used: 0, limit: 3 },
    }),
  );
  assert.equal(q("[data-merge-step]")!.getAttribute("data-merge-step"), "on");
  await act(async () => {
    q<HTMLButtonElement>("[role=switch]")!.click();
  });
  assert.deepEqual(takeCall(), {
    action: "setOrgLineMerge",
    args: [growth._id, false, null],
  });

  // ── how the merge step decides (regret.md R7): the rate sits beside it; Rate takes a bar and goes through the review ──
  const measured = { settled: 30, regretted: 3, partial: 5, rate: 0.9 };
  await render(
    React.createElement(MergeStepSwitch, {
      role: { ...growth, line_merge: true },
      canEdit: true,
      merge: {
        on: true,
        allowed: true,
        reason: null,
        used: 0,
        limit: 3,
        mode: "count",
        bar: null,
        measured,
      },
    }),
  );
  assert.equal(
    q("[data-merge-mode=count]")!.getAttribute("aria-pressed"),
    "true",
  );
  assert.match(
    q("[data-merge-measured]")!.textContent!,
    /90%regret-free30 finished · 3 fixed · 5 open/,
  );
  await render(
    React.createElement(MergeStepSwitch, {
      role: { ...growth, line_merge: true },
      canEdit: true,
      merge: {
        on: true,
        allowed: true,
        reason: null,
        used: 0,
        limit: 3,
        mode: "count",
        bar: null,
        measured: { settled: 0, regretted: 0, partial: 4, rate: null },
      },
    }),
  );
  assert.match(
    q("[data-merge-measured]")!.textContent!,
    /no rate yet ·0 finished · 4 open/,
  );
  await render(
    React.createElement(MergeStepSwitch, {
      role: { ...growth, line_merge: true },
      canEdit: true,
      merge: {
        on: true,
        allowed: true,
        reason: null,
        used: 0,
        limit: 3,
        mode: "count",
        bar: null,
        measured,
      },
    }),
  );
  await act(async () => {
    q<HTMLButtonElement>("[data-merge-mode=rate]")!.click();
  });
  assert.ok(q("[data-merge-rate-form]"), "Rate asks for its bar first");
  await act(async () => {
    q<HTMLButtonElement>("[data-merge-rate-form] button[type=submit]")!.click();
  });
  assert.equal(calls().length, 0, "the bar alone changes nothing");
  assert.equal(q('[data-switch-figure="bar"]')!.textContent, "90%");
  await act(async () => {
    q<HTMLButtonElement>("[data-switch-confirm]")!.click();
  });
  await waitForPopupClose();
  assert.deepEqual(takeCall(), {
    action: "setOrgLineMerge",
    args: [growth._id, true, null, { bar: 0.9, min: 20 }],
  });
  await render(
    React.createElement(MergeStepSwitch, {
      role: { ...growth, line_merge: true },
      canEdit: true,
      merge: {
        on: true,
        allowed: false,
        reason: "x",
        used: 0,
        limit: 3,
        mode: "rate",
        bar: { bar: 0.95, min: 20 },
        measured,
      },
    }),
  );
  assert.match(q("[data-merge-bar]")!.textContent!, /bar 95% · min 20/);
  await act(async () => {
    q<HTMLButtonElement>("[data-merge-mode=count]")!.click();
  });
  await act(async () => {
    q<HTMLButtonElement>("[data-switch-confirm]")!.click();
  });
  await waitForPopupClose();
  assert.deepEqual(takeCall(), {
    action: "setOrgLineMerge",
    args: [growth._id, true, null, null],
  });

  // ── the handoff banner: receivers, their state, the deadline, and the two acts ──
  const project = growth.scope_names.projects[0];
  const handing: OrgRole = {
    ...growth,
    handing_over: {
      reason: "retire",
      started_at: Date.now() - 3_600_000,
      deadline: Date.now() + 20 * 3_600_000,
      by: "u",
      trigger_id: "tr1",
      receivers: [
        {
          role_id: other._id,
          handle: other.handle,
          project_ids: project ? [project.id] : [],
          plan_ids: [],
        },
      ],
      retire: {},
    },
  };
  await render(
    React.createElement(HandingOverSection, {
      tree,
      role: handing,
      canEdit: true,
    }),
  );
  assert.equal(
    q("[data-handing-over]")!.getAttribute("data-handing-over"),
    "retire",
  );
  assert.match(text(), /It retires once this lands/);
  assert.match(text(), new RegExp(`@${other.handle}`));
  if (project) assert.match(text(), new RegExp(`takes ${project.title}`));
  assert.match(text(), /waiting/);
  assert.match(text(), /20h left/);
  await act(async () => {
    [...qa<HTMLButtonElement>("button")]
      .find((b) => b.textContent === "Hand over now")!
      .click();
  });
  assert.deepEqual(takeCall(), {
    action: "settleOrgHandoff",
    args: [growth._id, "run"],
  });
  await act(async () => {
    [...qa<HTMLButtonElement>("button")]
      .find((b) => /Close and retire now/.test(b.textContent ?? ""))!
      .click();
  });
  assert.deepEqual(takeCall(), {
    action: "settleOrgHandoff",
    args: [growth._id, "close"],
  });
  await render(
    React.createElement(HandingOverSection, {
      tree,
      role: growth,
      canEdit: true,
    }),
  );
  assert.equal(
    q("[data-handing-over]"),
    null,
    "no banner when nothing is handed over",
  );

  // ── succession: which role it took which area from, and whether the rest came ──
  const succeeded: OrgRole = {
    ...growth,
    succeeded: [
      {
        project_id: project?.id,
        from_role_id: other._id,
        from_handle: other.handle,
        from_name: other.name,
        at: Date.now() - 86_400_000,
        lines: 1,
      },
      {
        plan_id: "plans_x",
        from_role_id: "gone",
        from_handle: "old-lead",
        from_name: "Old",
        at: Date.now(),
        lines: 0,
        handed_at: Date.now(),
      },
    ],
  };
  await render(
    React.createElement(SuccessionSection, { tree, role: succeeded }),
  );
  assert.equal(qa("[data-succession-row]").length, 2);
  assert.match(text(), /1 line, handoff pending/);
  assert.match(text(), /@old-lead/);
  assert.match(text(), /no line, handoff/);

  // ── the split: readiness is pure; the dialog places every area and sends the partition ──
  const halves: [any, any] = [
    { handle: "growth-a", name: "A" },
    { handle: "growth-b", name: "B" },
  ];
  const areas = [{ key: "project:1" }, { key: "project:2" }, { key: "plan:3" }];
  assert.equal(splitReadiness(areas, {}, halves), "Place 3 more areas");
  assert.equal(
    splitReadiness(
      areas,
      { "project:1": 0, "project:2": 0, "plan:3": 0 },
      halves,
    ),
    "@growth-b would own nothing",
  );
  assert.equal(
    splitReadiness(
      areas,
      { "project:1": 0, "project:2": 1, "plan:3": 1 },
      halves,
    ),
    null,
  );
  assert.equal(
    splitReadiness(areas, { "project:1": 0, "project:2": 1, "plan:3": 1 }, [
      halves[0],
      { handle: "growth-a", name: "B" },
    ]),
    "The two roles need different handles",
  );
  assert.match(
    splitReadiness(areas, {}, [{ handle: "A!", name: "A" }, halves[1]])!,
    /not a handle/,
  );

  const wide: OrgRole = {
    ...growth,
    scope_names: {
      projects: [
        { id: "p1", title: "Website" },
        { id: "p2", title: "Ads" },
      ],
      plans: [{ id: "pl1", title: "Launch", short_id: "pl-1" }],
    },
    handing_over: undefined,
  };
  await render(
    React.createElement(SplitRoleSection, { tree, role: wide, canEdit: true }),
  );
  assert.ok(q("[data-split-section]"));
  await act(async () => {
    [...qa<HTMLButtonElement>("button")]
      .find((b) => /Split into two leads/.test(b.textContent ?? ""))!
      .click();
  });
  assert.ok(q("[data-split-dialog]"));
  assert.equal(q("[data-split-readiness]")!.textContent, "Place 3 more areas");
  const place = async (title: string, side: 0 | 1) => {
    await act(async () => {
      const area = q(`[data-split-area="${title}"]`)!;
      area.querySelectorAll<HTMLButtonElement>("button")[side].click();
    });
  };
  await place("Website", 0);
  await place("Ads", 1);
  await place("Launch", 1);
  assert.equal(q("[data-split-readiness]")!.textContent, "Ready");
  await act(async () => {
    [...qa<HTMLButtonElement>("button")]
      .find((b) => b.textContent === "Split")!
      .click();
  });
  const sent = takeCall()!;
  assert.equal(sent.action, "splitOrgRole");
  assert.deepEqual(sent.args, [
    {
      role_id: growth._id,
      halves: [
        {
          name: `${growth.name} A`,
          handle: `${growth.handle}-a`,
          refs: ["project:p1"],
        },
        {
          name: `${growth.name} B`,
          handle: `${growth.handle}-b`,
          refs: ["project:p2", "plan:pl1"],
        },
      ],
      standing_session: "keep",
    },
  ]);
  // One area or a handoff in flight: no split offered.
  await render(
    React.createElement(SplitRoleSection, {
      tree,
      role: {
        ...wide,
        scope_names: {
          projects: wide.scope_names.projects.slice(0, 1),
          plans: [],
        },
      },
      canEdit: true,
    }),
  );
  assert.equal(q("[data-split-section]"), null);
  await render(
    React.createElement(SplitRoleSection, {
      tree,
      role: handing,
      canEdit: true,
    }),
  );
  assert.equal(q("[data-split-section]"), null);

  await web.close();
}

test(
  "merge step, handoff banner, succession and split on the role page (L12, S32, S34)",
  verify,
  60_000,
);
