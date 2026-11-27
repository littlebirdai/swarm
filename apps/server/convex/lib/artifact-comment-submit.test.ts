import { expect, test } from "bun:test";
import { ARTIFACT_COMMENT_SUBMIT_SCRIPT } from "./artifact-comment-submit.script";

test("the published page keeps an ID across submission retries and retires it after success", () => {
  const { commentAttempt, commentAttempts } = new Function(
    "crypto",
    `${ARTIFACT_COMMENT_SUBMIT_SCRIPT}\nreturn { commentAttempt, commentAttempts };`,
  )({ getRandomValues: crypto.getRandomValues.bind(crypto) }) as {
    commentAttempt: (key: string, payload: unknown) => string;
    commentAttempts: Map<string, unknown>;
  };
  const payload = { comments: [{ text: "Check the totals" }] };
  const first = commentAttempt("batch", payload);
  expect(first).toMatch(/^[a-f0-9]{32}$/);
  expect(commentAttempt("batch", structuredClone(payload))).toBe(first);
  expect(commentAttempt("reply:first", payload)).not.toBe(first);
  commentAttempts.delete("batch");
  expect(commentAttempt("batch", payload)).not.toBe(first);
});
