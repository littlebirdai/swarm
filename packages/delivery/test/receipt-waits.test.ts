import { expect } from "bun:test";
import { it } from "@codecast/effect-kit/effect/testing";
import * as Effect from "effect/Effect";
import { makeReceiptWaits } from "../src/receipt-waits";
import { runFor } from "./fake-edge";

it.effect(
  "a new receipt wait for a session forgets its refused receipt wake",
  () =>
    Effect.sync(() => {
      const waits = makeReceiptWaits();
      const first = runFor("session-1");
      waits.expect(first);
      waits.refuse(first);
      expect(waits.refused()).toEqual([first]);

      const second = { ...runFor("session-1"), run: 2 };
      waits.expect(second);
      expect(waits.refused()).toEqual([]);
      expect(waits.awaiting("session-1")).toBe(second);
    }),
);
