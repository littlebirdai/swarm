import { describe, expect, test } from "bun:test";
import { formatScheduledTask, parseScheduledTask } from "./machineMessages";
import { roleCardInitiativeLine, type RoleCard } from "@codecast/org/roleCard";

describe("the role card carries what the area serves", () => {
  test("the frame writes and reads the initiatives with their chain and metric lines", () => {
    const role: RoleCard = {
      handle: "calling",
      name: "Calling lead",
      reports_to: "Ada",
      scope: ["Callers"],
      goals: ["Every broker answered in a day"],
      initiatives: [
        {
          short_id: "in-4",
          title: "Win the private network",
          chain: ["Reach 1k teams"],
          metrics: [
            "Weekly active teams: 412 of 1,000, behind (3 days ago)",
            "Brokers live: not reported yet, target 40",
          ],
        },
        { short_id: "in-1", title: "Reach 1k teams", chain: [], metrics: [] },
      ],
    };
    const frame = formatScheduledTask({
      title: "Check Callers",
      trigger: "tr-1",
      role,
      body: "Read your area.",
    });
    expect(frame).toContain(
      "Serves: Win the private network (in-4), under Reach 1k teams; Weekly active teams: 412 of 1,000, behind (3 days ago); Brokers live: not reported yet, target 40",
    );
    expect(frame).toContain("Serves: Reach 1k teams (in-1)</role-card>");
    const back = parseScheduledTask(frame)!;
    expect(back.role?.initiatives).toEqual(role.initiatives);
    expect(back.body).toBe("Read your area.");
    expect(roleCardInitiativeLine(role.initiatives![1])).toBe(
      "Reach 1k teams (in-1)",
    );
  });

  test("a card from before the field reads with no initiatives", () => {
    const role: RoleCard = {
      handle: "docs",
      name: "Docs lead",
      reports_to: "Ada",
      scope: [],
      goals: [],
    };
    const back = parseScheduledTask(
      formatScheduledTask({ title: "t", role, body: "b" }),
    )!;
    expect(back.role).toEqual(role);
  });
});
