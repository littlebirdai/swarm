import type { OrgObjectKind } from "@codecast/entities";
import { spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { act } from "react";
import { syncMetaKey } from "../../../../hooks/reconcileCrawl";
import { stampRoster } from "../../../../lib/activeTeam";
import type { TaskItem } from "../../../../store/inboxStore";
import { webBuilders } from "../../../../test-helpers/builders";
import {
  expectAbsent,
  expectPresent,
} from "../../../../test-helpers/domExpect";
import { mountWeb } from "../../../../test-helpers/mountWeb";
import * as fx from "../../../company/companyFixture";
import { ObjectSummary } from "../ObjectSummary";

const tree = fx.COMPANY_FIXTURE_TREE;
const teamId = "u".repeat(32);
const workspace = `team:${teamId}` as const;
const builders = webBuilders("ObjectSummary.mount.test.tsx");

async function verifySummaries() {
  const clock = spyOn(Date, "now").mockReturnValue(fx.COMPANY_FIXTURE_NOW);
  try {
    const goal = fx.COMPANY_FIXTURE_INITIATIVES.find(
      (row) => row.short_id === "in-2",
    )!;
    const web = await mountWeb(
      <ObjectSummary kind="initiative" ref={goal.short_id ?? goal._id} />,
      {
        path: "/org",
        setup(_backend, store) {
          store.syncTable("currentUser", { _id: "fixture-user-me" });
          store.syncTable("clientState", {
            ui: { active_team_id: teamId, show_characters: true },
          });
          store.syncTable("orgTree", {
            ...tree,
            workspace: { kind: "team", id: teamId, name: "Union" },
          });
          store.syncTable(
            "teamMembers",
            stampRoster(fx.COMPANY_FIXTURE_ROSTER, teamId),
          );
          store.syncTable("initiatives", [
            {
              ...goal,
              _id: "foreign-goal",
              title: "Another team's goal",
              workspace: "team:foreign",
            },
            ...fx.COMPANY_FIXTURE_INITIATIVES.map((row) => ({
              ...row,
              workspace,
            })),
          ]);
          store.syncTable(
            "projects",
            fx.COMPANY_FIXTURE_PROJECTS.map((row) =>
              builders.project.build({ ...row, workspace }),
            ),
          );
          store.syncTable(
            "tasks",
            fx.COMPANY_FIXTURE_TASKS.map((row) =>
              builders.task.build({ ...(row as Partial<TaskItem>), workspace }),
            ),
          );
          store.recordSyncMeta(syncMetaKey("tasks", "skip"), {
            backfilledAt: fx.COMPANY_FIXTURE_NOW,
          });
          store.recordSyncMeta(
            syncMetaKey(
              "tasks",
              JSON.stringify({ team_id: teamId, workspace: "team" }),
            ),
            { backfilledAt: fx.COMPANY_FIXTURE_NOW },
          );
        },
      },
    );
    const show = (kind: OrgObjectKind, ref: string) =>
      web.rerender(<ObjectSummary kind={kind} ref={ref} />);
    const q = (sel: string) => document.querySelector<HTMLElement>(sel);
    const facts = () =>
      [...q("[data-summary-facts]")!.children]
        .filter(
          (c) =>
            c.tagName !== "SPAN" || c.getAttribute("aria-hidden") !== "true",
        )
        .map((c) => c.textContent);
    const serves = () =>
      [...document.querySelectorAll("[data-summary-serves-item]")].map((a) =>
        a.getAttribute("href"),
      );

    // A goal: owner, health and when it was said, the number now of target, the target day.
    await show("initiative", "in-2");
    assert.equal(
      q("[data-object-summary]")!.getAttribute("data-object-summary"),
      "initiative",
    );
    assert.equal(
      q("[data-summary-title]")!.textContent,
      "Win the private network",
    );
    const goalFacts = facts();
    assert.equal(goalFacts.length, 4);
    assert.match(goalFacts[0]!, /Ashot Petrosian/);
    assert.match(goalFacts[1]!, /on track/);
    assert.match(goalFacts[2]!, /^17 of 40/);
    expectPresent(q("[data-summary-facts] [data-initiative-target]"));
    assert.equal(
      q("[data-initiative-pick]"),
      null,
      "read only: the pickers live on the line and the sheet",
    );
    assert.deepEqual(
      serves(),
      [],
      "a top level goal serves the mission the header names",
    );
    // What carries it, by name: its projects, then the goals under it, two and a count.
    assert.match(
      q("[data-summary-carried]")!.textContent!,
      /^Carried by.+, .+ \+1$/,
    );
    // A goal that feeds another serves it, by a name that opens it.
    await show("initiative", "in-5");
    assert.deepEqual(serves(), ["/goals/in-2"]);
    await act(async () => q("[data-summary-serves-item='in-2']")!.click());
    assert.deepEqual(web.navigationLog.at(-1), {
      action: "push",
      path: "/goals/in-2",
    });

    // A role, named as the map names it with its title beside: who it reports
    // to, its own word, since when; the goals it drives, and what it carries by
    // name. The facts leave the project it leads to Carries rather than say it twice.
    await show("role", "or-36");
    assert.equal(q("[data-summary-title]")!.textContent, "Agent Quality");
    assert.equal(q("[data-summary-sub]")!.textContent, "Ripple");
    assert.equal(facts().length, 3);
    assert.deepEqual(facts().slice(0, 2), ["↳ Ashot Petrosian", "dormant"]);
    assert.match(facts()[2]!, /^since /);
    assert.deepEqual(
      serves(),
      ["/goals/in-4", "/goals/in-1"],
      "the goal it owns first, then the one its project carries",
    );
    assert.equal(
      q("[data-summary-carried]")!.textContent,
      "CarriesAgent Quality",
    );

    // A project: its lead, what is moving, its board's count; the goal it serves; the roles working it.
    await show("project", "pr-12");
    assert.equal(q("[data-summary-title]")!.textContent, "Agent Quality");
    const projectFacts = facts();
    assert.match(projectFacts[0]!, /Agent Quality/);
    assert.match(projectFacts[1]!, /needs you/);
    assert.equal(projectFacts[2], "10 of 18 tasks");
    assert.deepEqual(serves(), ["/goals/in-1"]);
    assert.equal(
      q("[data-summary-carried]")!.textContent,
      "Carried byAgent Quality",
    );

    // A person, found by handle: their place, presence, what they answer for, since when; the goals they own.
    await show("person", "@ashot");
    assert.match(q("[data-summary-title]")!.textContent!, /^Ashot Petrosian/);
    assert.equal(
      q("[data-summary-id]")!.textContent,
      "@ashot",
      "their handle beside their name",
    );
    // Goals and roles are named on Serves and Carries; the facts keep only what is live now.
    assert.equal(facts().length, 4);
    assert.deepEqual(facts().slice(0, 3), [
      "owner",
      "online",
      "5 sessions at work, 4 waiting on input",
    ]);
    assert.match(facts()[3]!, /^since Jan(?: 2026)?$/);
    assert.ok(
      facts().every((f) => !/\bgoal|\brole/.test(f!)),
      "no goal or role count in the facts",
    );
    assert.deepEqual(serves(), ["/goals/in-2"]);
    // The roles they host or that report to them, by name.
    assert.match(q("[data-summary-carried]")!.textContent!, /^Carries\S/);

    // Nothing by that ref: nothing drawn.
    await show("initiative", "in-404");
    expectAbsent(q("[data-object-summary]"));

    await web.close();
  } finally {
    clock.mockRestore();
  }
}

test("object summaries: one per kind, the line's facts in the one order, what it serves and what carries it", async () => {
  await verifySummaries();
}, 300_000);
