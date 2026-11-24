import { describe, expect, test } from "bun:test";
import {
  placeProjectableRow,
  projectInbox,
  rowLiveDeadlines,
} from "../src/inboxProjection";

const now = 1_800_000_000_000;
const row = {
  _id: "session",
  status: "active",
  updated_at: now - 40 * 86400_000,
  message_count: 10,
  is_idle: true,
  agent_status: "done",
  inbox_snoozed_until: now + 60_000,
};

describe("session snooze", () => {
  test("snooze wins over running, done, dormant, questions, and pins", () => {
    for (const agent_status of [
      "working",
      "done",
      "dormant",
      "permission_blocked",
      "stopped",
    ]) {
      expect(
        placeProjectableRow(
          { ...row, agent_status, inbox_pinned_at: 1 },
          true,
          now,
        ),
      ).toEqual({ bucket: "snoozed", work_state: "dormant" });
    }
  });

  test("expiry returns to Needs You even with an old verdict or question", () => {
    for (const agent_status of [
      "working",
      "done",
      "dormant",
      "permission_blocked",
    ]) {
      expect(
        placeProjectableRow(
          { ...row, agent_status },
          true,
          row.inbox_snoozed_until,
        ),
      ).toEqual({ bucket: "needs_input", work_state: "needs_input" });
    }
  });

  test("snoozed and due sessions stay in the working set beyond thirty days", () => {
    for (const time of [now, now + 90 * 86400_000]) {
      const result = projectInbox([row], time);
      expect(result.placements.get("session")?.below_fold).toBe(false);
      expect(result.placements.get("session")?.bucket).toBe(
        time === now ? "snoozed" : "needs_input",
      );
    }
    expect(rowLiveDeadlines(row)).toContain(row.inbox_snoozed_until);
  });

  test("kill and stash remain deliberate overrides after their snooze stamp is cleared", () => {
    expect(
      placeProjectableRow(
        {
          ...row,
          inbox_snoozed_until: null,
          inbox_dismissed_at: now,
          inbox_killed_at: now,
        },
        true,
        now,
      ).bucket,
    ).toBe("dismissed");
    expect(
      placeProjectableRow(
        { ...row, inbox_snoozed_until: null, inbox_stashed_at: now },
        true,
        now,
      ).bucket,
    ).toBe("stashed");
  });
});
