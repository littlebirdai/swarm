import { expect, test } from "bun:test";
import { makeReceiptWaits } from "../src/receipt-waits";
import { runFor } from "./fake-edge";

test("a new receipt wait for a session forgets its refused receipt wake", () => {
  const waits = makeReceiptWaits();
  const first = runFor("session-1");
  waits.expect(first);
  waits.refuse(first);
  expect(waits.refused()).toEqual([first]);

  const second = { ...runFor("session-1"), run: 2 };
  waits.expect(second);
  expect(waits.refused()).toEqual([]);
  expect(waits.awaiting("session-1")).toBe(second);
});
