import { describe, expect, it } from "bun:test";
import { diffMessageTail } from "../persistence/messageTailDiff";

describe("message tail diff", () => {
  const first = { _id: "a", images: [{ data: "image bytes" }] };
  const second = { _id: "b", content: "partial response" };
  const third = { _id: "c", content: "next message" };
  const previous = diffMessageTail(new Map(), [first, second]).next;

  it("writes only changed content from a rebuilt array", () => {
    const updated = { ...second, content: "complete response" };
    const diff = diffMessageTail(previous, [structuredClone(first), updated]);
    expect(diff.puts.map(({ message }) => message)).toEqual([updated]);
    expect(diff.deletes).toEqual([]);
    expect(previous.get("0:id:b")?.message).toEqual(second);
  });

  it("deletes the dropped key and puts the appended row", () => {
    const diff = diffMessageTail(previous, [second, third]);
    expect(diff.puts.map(({ message }) => message)).toEqual([third]);
    expect(diff.deletes).toEqual(["0:id:a"]);
    expect([...diff.next.values()].map(({ message }) => message)).toEqual([
      second,
      third,
    ]);
  });

  it("fits an insert between the existing positions", () => {
    const diff = diffMessageTail(previous, [first, third, second]);
    expect(diff.puts).toEqual([
      { messageKey: "0:id:c", position: 0.5, message: third },
    ]);
  });

  it("preserves order after repeated inserts exhaust the gap between positions", () => {
    let results = diffMessageTail(new Map(), [first, second, third]);
    let neighbor = third;
    for (let i = 0; i < 64; i++) {
      const inserted = {
        _id: `insert-${i}`,
        content: "inserted between neighbors",
      };
      results = diffMessageTail(results.next, [
        first,
        second,
        inserted,
        neighbor,
      ]);
      const positions = [...results.next.values()].map(
        ({ position }) => position,
      );
      expect(
        positions.every(
          (position, j) => j === 0 || position > positions[j - 1],
        ),
      ).toBe(true);
      neighbor = inserted;
    }
  });

  it("preserves duplicate IDs, uses a client ID fallback, and restores exact order", () => {
    const optimistic = { _clientId: "b", content: "optimistic" };
    const replay = { ...first, images: [] };
    const original = diffMessageTail(new Map(), [first, optimistic, replay]);
    expect(original.next.size).toBe(3);
    const reordered = diffMessageTail(original.next, [
      optimistic,
      first,
      replay,
    ]);
    expect([...reordered.next.values()].map(({ message }) => message)).toEqual([
      optimistic,
      first,
      replay,
    ]);
    expect(reordered.puts.map(({ message }) => message)).toEqual([first]);
    expect(reordered.deletes).toEqual([]);
  });
});
