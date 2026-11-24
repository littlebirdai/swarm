import { describe, expect, test } from "bun:test";
import { sessionCommandOutcome } from "./hibernation";

describe("intentional hibernation", () => {
  test("command completion distinguishes acknowledgment, refusal, failure and unknown", () => {
    expect(
      sessionCommandOutcome({ command: "hibernate_session" }).message,
    ).toBe("parking requested");
    expect(
      sessionCommandOutcome({
        command: "hibernate_session",
        executed_at: 1,
        result: "hibernated",
      }).state,
    ).toBe("succeeded");
    expect(
      sessionCommandOutcome({
        executed_at: 1,
        result: "skipped_target-unverified",
        error: "not parked: target-unverified",
      }).state,
    ).toBe("skipped");
    expect(
      sessionCommandOutcome({ executed_at: 1, error: "offline" }).state,
    ).toBe("failed");
    expect(
      sessionCommandOutcome({
        command: "resume_session",
        executed_at: 1,
        result: '{"resumed":true}',
      }).state,
    ).toBe("succeeded");
    expect(
      sessionCommandOutcome({
        command: "resume_session",
        executed_at: 1,
        result: '{"resumed":false}',
      }).state,
    ).toBe("failed");
  });
});
