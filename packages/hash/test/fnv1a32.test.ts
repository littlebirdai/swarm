import { describe, expect, it, test } from "bun:test";
import { FNV1A32_OFFSET, fnv1a32, fnv1a32Update } from "../src/fnv1a32";

describe("FNV-1a", () => {
  test("fnv1a32 matches the reference vectors", () => {
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("a")).toBe(0xe40c292c);
  });

  it("fnv1a32 is the reference FNV-1a over UTF-16 code units", () => {
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("a")).toBe(0xe40c292c);
    expect(fnv1a32("hello world")).toBe(0xd58b3fa7);
  });

  test("folding a string in pieces equals hashing it whole", () => {
    const whole = fnv1a32("abc:working:0");
    expect(
      fnv1a32Update(fnv1a32Update(FNV1A32_OFFSET, "abc:"), "working:0"),
    ).toBe(whole);
  });
});
