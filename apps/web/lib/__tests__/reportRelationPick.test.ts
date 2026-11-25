import { describe, expect, it } from "bun:test";
import { act } from "react";
import { mountWeb } from "../../test-helpers/mountWeb";
import { testToasts } from "../../test-helpers/testToasts";
import { reportRelationPick } from "../taskRelations";

const pick = (landed: Promise<string>, pr = false) =>
  pr
    ? {
        ok: true as const,
        pending: true as const,
        message: "Checking PR o/r#42 for ct-1…",
        parked: "ct-1 will wait on PR #42 once it reaches the server",
        landed,
      }
    : { ok: true as const, message: "ct-1 waits on decision sd-4", landed };

async function notice() {
  await mountWeb(null, { clock: true });
  return testToasts();
}

describe("reportRelationPick", () => {
  for (const [name, startingType, initial, final, pr] of [
    [
      "turns a PR check into what landed",
      "loading",
      "Checking PR o/r#42 for ct-1…",
      "ct-1 waits on PR #42: already merged",
      true,
    ],
    [
      "says when a wait was met at once",
      "success",
      "ct-1 waits on decision sd-4",
      "ct-1 waits on decision sd-4: already answered: yes",
      false,
    ],
  ] as const) {
    it(name, async () => {
      const notices = await notice();
      const landed = Promise.withResolvers<string>();
      await act(() => reportRelationPick(pick(landed.promise, pr)));
      expect(notices.events()).toEqual([
        {
          event: "show",
          id: expect.any(Number),
          kind: startingType,
          title: initial,
        },
      ]);
      const id = notices.events()[0]!.id;
      await act(async () => landed.resolve(final));
      expect(notices.events()).toEqual([
        { event: "show", id, kind: startingType, title: initial },
        { event: "update", id, kind: "success", title: final },
      ]);
    });
  }

  it("leaves a pick that landed as said alone", async () => {
    const notices = await notice();
    const message = "ct-1 waits on decision sd-4";
    await act(async () => reportRelationPick(pick(Promise.resolve(message))));
    expect(notices.events()).toEqual([
      {
        event: "show",
        id: expect.any(Number),
        kind: "success",
        title: message,
      },
    ]);
  });

  it("clears the toast on a refusal", async () => {
    const notices = await notice();
    const landed = Promise.withResolvers<string>();
    await act(() => reportRelationPick(pick(landed.promise, true)));
    expect(notices.events()).toEqual([
      {
        event: "show",
        id: expect.any(Number),
        kind: "loading",
        title: "Checking PR o/r#42 for ct-1…",
      },
    ]);
    await act(async () =>
      landed.reject(new Error("Uncaught Error: codecast cannot see PR o/r#42")),
    );
    const [loading] = notices.events();
    expect(notices.events()).toEqual([
      loading,
      { ...loading, event: "dismiss" },
    ]);
    expect(notices.read()).toEqual([]);
  });

  it("says a parked PR wait will land", async () => {
    const notices = await notice();
    const landed = Promise.withResolvers<string>();
    await act(() => reportRelationPick(pick(landed.promise, true)));
    expect(notices.events()).toEqual([
      {
        event: "show",
        id: expect.any(Number),
        kind: "loading",
        title: "Checking PR o/r#42 for ct-1…",
      },
    ]);
    const id = notices.events()[0]!.id;
    await act(async () => landed.reject(new Error("network down")));
    expect(notices.events()).toEqual([
      {
        event: "show",
        id,
        kind: "loading",
        title: "Checking PR o/r#42 for ct-1…",
      },
      {
        event: "update",
        id,
        kind: "normal",
        title: "ct-1 will wait on PR #42 once it reaches the server",
      },
    ]);
  });

  it("says a refused pick at once", async () => {
    const notices = await notice();
    const title = "A task can't wait on itself";
    await act(() => reportRelationPick({ ok: false, message: title }));
    expect(notices.events()).toEqual([
      { event: "show", id: expect.any(Number), kind: "error", title },
    ]);
  });
});
