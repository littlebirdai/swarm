import { expect, test } from "bun:test";
import { validMessagesSdkPage } from "./messagesSdkTypes.js";

test("bounded SDK receipt validates every identity field without accepting optional garbage", () => {
  const receipt = {
    plan: "plan",
    attempt: "attempt",
    workerGeneration: 1,
    messageCount: 25,
  };
  const page = {
    cursor: "cursor",
    generation: "generation",
    sequence: 3,
    stage: "outcome",
    receipt,
  };
  expect(validMessagesSdkPage(page)).toBe(true);
  for (const [field, values] of Object.entries({
    plan: ["", 1, "x".repeat(97)],
    attempt: ["", false],
    workerGeneration: [0, -1, NaN, "1"],
    messageCount: [-1, 1.5, 1_000_001, false],
  })) {
    for (const value of values)
      expect(
        validMessagesSdkPage({
          ...page,
          receipt: { ...receipt, [field]: value },
        }),
      ).toBe(false);
    const missing: Record<string, unknown> = { ...receipt };
    delete missing[field];
    expect(validMessagesSdkPage({ ...page, receipt: missing })).toBe(false);
  }
  expect(
    validMessagesSdkPage({ ...page, receipt: { ...receipt, accepted: true } }),
  ).toBe(false);
  expect(validMessagesSdkPage({ ...page, receipt: undefined })).toBe(false);
  expect(validMessagesSdkPage({ ...page, stage: "ready" })).toBe(false);
});
