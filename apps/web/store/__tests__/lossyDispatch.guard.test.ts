import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";

describe("lossy raw dispatch writers", () => {
  test("store preference, draft, and undo writers use named durable actions", async () => {
    const [storeSource, undoSource] = await Promise.all([
      Bun.file(new URL("../inboxStore.ts", import.meta.url)).text(),
      Bun.file(new URL("../undoActions.ts", import.meta.url)).text(),
    ]);

    const sliceDir = new URL("../slices/", import.meta.url);
    const sliceSources = await Promise.all(
      readdirSync(sliceDir)
        .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
        .map((file) => Bun.file(new URL(file, sliceDir)).text()),
    );
    for (const source of [storeSource, ...sliceSources]) {
      expect(source).not.toContain('._dispatch("patch"');
      expect(source).not.toContain('._dispatch("clearDraft"');
    }
    expect(undoSource).not.toContain("._dispatch(");
  });
});
