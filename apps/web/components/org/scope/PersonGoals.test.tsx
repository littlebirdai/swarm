import { expect, test } from "bun:test";
import { act } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import { mountWeb } from "../../../test-helpers/mountWeb";
import { webBuilders } from "../../../test-helpers/builders";
import { pending } from "../../../test-helpers/testConvex";
import { PersonGoals } from "./PersonGoals";
import type { BriefPerson } from "./scopeTypes";

const matched = webBuilders("PersonGoals.test.tsx").task.build({
  short_id: "ct-7",
  title: "R6",
});

const NOW = Date.parse("2026-09-19T15:00:00Z");
const H = 3_600_000;
const person = (over: Partial<BriefPerson>): BriefPerson => ({
  user_id: "u1",
  name: "Ashot",
  has_section: true,
  goals: [],
  sessions_changed: [],
  sessions_total: 0,
  stalled_high: 0,
  ...over,
});

test("each goal shows what is matched to it, what moved and what stalled", async () => {
  const { container, navigationLog } = await mountWeb(
    <PersonGoals
      own
      roleHandle="head"
      now={NOW}
      person={person({
        goals: [
          {
            text: "Ship org roles",
            priority: "high",
            raw: "",
            refs: [
              {
                kind: "task",
                short_id: "ct-7",
                title: "R6",
                status: "in_progress",
                updated_at: NOW - 2 * H,
              },
            ],
            unresolved: [],
            moved_at: NOW - 2 * H,
            stalled: false,
            unmatched: false,
          },
          {
            text: "Close the round",
            priority: "high",
            raw: "",
            refs: [],
            unresolved: [],
            moved_at: null,
            stalled: true,
            unmatched: false,
          },
        ],
      })}
    />,
    {
      setup: (backend, store) => {
        backend.set(api.tasks.webGet, pending);
        store.syncTable("tasks", [matched]);
      },
    },
  );
  expect(container.innerHTML).toContain('data-person-goals="2"');
  expect(container.innerHTML).toContain("Ship org roles");
  const pill = container.querySelector<HTMLAnchorElement>(
    `a[href="/tasks/${matched._id}"]`,
  );
  expect(pill?.textContent).toContain(matched.title);
  expect(container.innerHTML).toContain("ct-7 in_progress · moved 2h ago");
  expect(container.innerHTML).toContain('data-goal-stalled="1"');
  expect(container.innerHTML).toContain("nothing matched · stalled");
  await act(() => pill!.click());
  expect(navigationLog.at(-1)).toEqual({
    action: "push",
    path: `/tasks/${matched._id}`,
  });
});

test("a person with no focus section is told how to give the role their focus, in their own voice or the reader's", async () => {
  const { container, rerender } = await mountWeb(
    <PersonGoals
      own
      roleHandle="head"
      now={NOW}
      person={person({ has_section: false })}
    />,
  );
  expect(container.textContent).toContain("You report to @head");
  expect(container.textContent).toContain("it doesn't know your focus yet");
  expect(container.textContent).toContain(
    "three to five priorities in the conversation",
  );
  expect(container.textContent).not.toContain("## Goals");
  await rerender(
    <PersonGoals
      own={false}
      roleHandle="head"
      now={NOW}
      person={person({ has_section: false })}
    />,
  );
  expect(container.textContent).toContain("Ashot reports to @head");
});
