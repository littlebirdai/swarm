import { describe, expect, it } from "bun:test";
import { unionHydrate } from "../inboxHydration";

describe("unionHydrate — cache as the floor (jx799py repro)", () => {
  // Bug: /tasks (and now delta sessions) collapse to the live window on load,
  // then stream back in. IDB holds the full set the whole time; the deferred
  // hydration's empty-gate skipped IDB because a windowed live payload had
  // already filled the store. Union-merge makes the cache the floor.
  it("backfills cached rows the live window omits; live wins per-id", () => {
    // IDB has the full set (N=5). The live payload is a recent-window subset (2).
    const idb = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [
        `t${i}`,
        { _id: `t${i}`, title: `idb-${i}` },
      ]),
    );
    const liveWindow = {
      t0: { _id: "t0", title: "live-0" },
      t1: { _id: "t1", title: "live-1" },
    };

    const merged = unionHydrate(idb, liveWindow) as Record<
      string,
      { _id: string; title: string }
    >;

    // Full set survives — NOT collapsed to the 2-row live window.
    expect(Object.keys(merged).length).toBe(5);
    // Live rows win per-id; cache backfills the rest.
    expect(merged.t0.title).toBe("live-0");
    expect(merged.t1.title).toBe("live-1");
    expect(merged.t4.title).toBe("idb-4");
  });

  it("returns the cache untouched when no live data has landed yet", () => {
    const idb = { a: { _id: "a" }, b: { _id: "b" } };
    expect(unionHydrate(idb, undefined)).toEqual(idb);
  });

  it("returns the live set when there is no cache", () => {
    const live = { a: { _id: "a" } };
    expect(unionHydrate(undefined, live)).toBe(live);
  });

  it("keeps the populated collection identity when the cache adds no rows", () => {
    const cached = { a: { _id: "a", title: "cached" } };
    const live = {
      a: { _id: "a", title: "live" },
      b: { _id: "b", title: "new" },
    };
    expect(unionHydrate(cached, live)).toBe(live);
    expect(unionHydrate({ a: undefined }, { a: undefined })).toEqual({
      a: undefined,
    });
  });
});
