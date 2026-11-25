import assert from "node:assert/strict";

export function expectAbsent(
  node: Element | null,
  message = "Expected no matching element",
) {
  assert.equal(node === null, true, message);
}

export function expectPresent<T extends Element>(
  node: T | null,
  message = "Expected a matching element",
): asserts node is T {
  assert.equal(node !== null, true, message);
}
