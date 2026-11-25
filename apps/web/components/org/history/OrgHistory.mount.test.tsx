import { api } from "@codecast/convex/convex/_generated/api";
import type { OrgLogEntry, OrgUndoPreview } from "@codecast/org/orgChange";
import type { FunctionArgs, FunctionReference } from "convex/server";
import assert from "node:assert/strict";
import { afterEach, describe, it, spyOn } from "bun:test";
import { act, type ReactNode } from "react";
import { expectAbsent, expectPresent } from "../../../test-helpers/domExpect";
import { mountWeb } from "../../../test-helpers/mountWeb";
import { pending } from "../../../test-helpers/testConvex";
import { orgLogFixture } from "./orgLogFixture";
import { OrgHistory } from "./OrgHistory";

const now = new Date(2026, 8, 20, 15).getTime();
const team = "h".repeat(32);
const batch = (ref: string) => ref.replace("-", "").padEnd(32, "0");
const fixture = orgLogFixture(now);
const entry = (r: OrgLogEntry): OrgLogEntry => ({
  ...r,
  _id: batch(r._id),
  batch: batch(r.batch),
  workspace: `team:${team}`,
  team_id: team,
  ...(r.undone_by
    ? { undone_by: { ...r.undone_by, batch: batch(r.undone_by.batch) } }
    : {}),
});
const previewUndo: FunctionReference<
  "query",
  "public",
  FunctionArgs<typeof api.orgChanges.previewUndo>,
  OrgUndoPreview | null
> = api.orgChanges.previewUndo;
let entries = fixture.entries;
let ready = false;
let preview: OrgUndoPreview | null | undefined = fixture.previews["b-ask"];
let web: Awaited<ReturnType<typeof mountWeb>> | undefined;
let restoreClock: (() => void) | undefined;
afterEach(() => {
  web = undefined;
  restoreClock?.();
  restoreClock = undefined;
  entries = fixture.entries;
  ready = false;
  preview = fixture.previews["b-ask"];
});

const q = <T extends Element = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector);
const click = (selector: string) =>
  act(async () => q<HTMLButtonElement>(selector)!.click());
const mount = async (node: ReactNode) => {
  await web?.close();
  if (!restoreClock) {
    const clock = spyOn(Date, "now").mockReturnValue(now);
    restoreClock = () => clock.mockRestore();
  }
  web = await mountWeb(node, {
    path: "/org/history",
    dispatch: true,
    setup(backend, store) {
      store.syncTable("clientState", { ui: { active_team_id: team } });
      store.syncTable("orgLog", [
        ...entries.map(entry),
        {
          ...entry(fixture.entries[0]),
          _id: "other-workspace",
          workspace: "team:other",
          at: now,
        },
      ]);
      store.syncTable(
        "orgLogRows",
        Object.values(fixture.rows)
          .flat()
          .map((r) => ({ ...r, batch: batch(r.batch) })),
      );
      backend.set(
        api.orgChanges.list,
        ready ? { entries: [], has_more: false } : pending,
      );
      backend.set(api.orgChanges.get, pending);
      backend.set(previewUndo, ({ batch: ref }) => {
        if (!preview) return preview === null ? null : pending;
        if (ref !== batch(preview.batch)) return null;
        return { ...preview, batch: ref, depends: preview.depends.map(entry) };
      });
      backend.mutation(api.dispatch.dispatch, null);
    },
  });
};
const writes = () =>
  web!.backend.mutations.flatMap(({ name, args }) =>
    name === "dispatch:dispatch" &&
    args &&
    typeof args === "object" &&
    !Array.isArray(args) &&
    !(args instanceof ArrayBuffer)
      ? [{ action: args.action, args: args.args }]
      : [],
  );
const entrySel = (ref: string) => `[data-org-history-entry="${batch(ref)}"]`;

describe("Org History", () => {
  it("paints the cached entries before the feeder is ready, grouped newest first", async () => {
    await mount(<OrgHistory />);
    expectAbsent(q("[data-org-history-skeleton]"));
    assert.equal(
      q("[data-org-history-day]")!.getAttribute("data-org-history-day"),
      "Today",
    );
    assert.equal(
      q("[data-org-history-entry]")!.getAttribute("data-org-history-entry"),
      batch("b-ask"),
    );
    assert.match(q("[data-org-history-line]")!.textContent!, /100 records/);
    assert.match(
      q("[data-org-history-meta]")!.textContent!,
      /Ashot Petrosian.*proposal op-7/,
    );
    assert.equal(q(entrySel("b-lead") + " [data-org-history-act]"), null);
  });

  it("unfolds the rows, then the full hundred, without waiting for the feeder", async () => {
    await mount(<OrgHistory />);
    await click(entrySel("b-ask") + " [data-org-history-fold]");
    assert.equal(
      document.querySelectorAll("[data-org-history-row]").length,
      12,
    );
    await click("[data-org-history-rows-all]");
    assert.equal(
      document.querySelectorAll("[data-org-history-row]").length,
      100,
    );
    await click(entrySel("b-ask") + " [data-org-history-fold]");
    assert.equal(q("[data-org-history-rows]"), null);
  });

  it("says all four parts before confirmation and passes dependent batches to the action", async () => {
    preview = {
      ...fixture.previews["b-ask"],
      depends: [entries[1]],
      cannot_take_back: [{ kind: "message_sent", count: 2 }],
    };
    await mount(<OrgHistory />);
    await click(entrySel("b-ask") + " [data-org-history-act]");
    assert.deepEqual(
      [...document.querySelectorAll("[data-undo-part]")].map((e) =>
        e.getAttribute("data-undo-part"),
      ),
      ["will-change", "left-alone", "depends", "cannot"],
    );
    assert.match(q("[data-undo-left-line]")!.textContent!, /3 of 100/);
    assert.equal(q("[data-undo-confirm]")!.textContent, "Take back all 2");
    assert.deepEqual(writes(), []);
    await click("[data-undo-confirm]");
    const [write] = writes();
    assert.equal(write.action, "undoOrgChange");
    assert.ok(Array.isArray(write.args));
    assert.equal(write.args[0], batch("b-ask"));
    const options = write.args[1];
    assert.ok(
      options &&
        typeof options === "object" &&
        !Array.isArray(options) &&
        !(options instanceof ArrayBuffer),
    );
    assert.deepEqual(options.with, [batch("b-budget")]);
    assert.equal(q("[data-undo-preview]"), null);
  });

  it("keeps the undone entry in place and routes redo through its own store action", async () => {
    preview = fixture.previews["b-hire"];
    await mount(<OrgHistory />);
    assert.ok(q(entrySel("b-hire") + "[data-undone]"));
    assert.ok(
      q(entrySel("b-hire") + " [data-org-history-line]")!.classList.contains(
        "line-through",
      ),
    );
    assert.match(
      q("[data-org-history-undone-by]")!.textContent!,
      /Taken back by Ashot/,
    );
    await click(entrySel("b-hire") + ' [data-org-history-act="redo"]');
    assert.equal(q("[data-undo-confirm]")!.textContent, "Apply again");
    await click("[data-undo-confirm]");
    const [write] = writes();
    assert.equal(write.action, "redoOrgChange");
    assert.ok(Array.isArray(write.args));
    assert.equal(write.args[0], batch("b-hire"));
  });

  it("loading, refusal, missing preview and nothing left to undo cannot write", async () => {
    for (const value of [
      undefined,
      null,
      {
        ...fixture.previews["b-ask"],
        refused: "Only a person who can edit this role may undo it.",
      },
      { ...fixture.previews["b-ask"], will_change: [] },
    ]) {
      preview = value;
      await mount(<OrgHistory />);
      await click(entrySel("b-ask") + " [data-org-history-act]");
      assert.equal(q<HTMLButtonElement>("[data-undo-confirm]")!.disabled, true);
      await click("[data-undo-confirm]");
      assert.deepEqual(writes(), []);
      await click("[data-undo-cancel]");
      assert.equal(q("[data-undo-preview]"), null);
    }
  });

  it("filters the role's Scope history and offers earlier changes", async () => {
    let more = 0;
    await mount(
      <OrgHistory
        roleId="fixture-role-growth"
        limit={1}
        onMore={() => more++}
      />,
    );
    assert.equal(
      document.querySelectorAll("[data-org-history-entry]").length,
      1,
    );
    assert.equal(
      q("[data-org-history-entry]")!.getAttribute("data-org-history-entry"),
      batch("b-budget"),
    );
    await click("[data-org-history-more]");
    assert.equal(more, 1);
  });

  it("a genuinely cold cache shows a skeleton and an empty ready cache shows the empty state", async () => {
    entries = [];
    await mount(<OrgHistory />);
    expectPresent(q("[data-org-history-skeleton]"));
    ready = true;
    await mount(<OrgHistory />);
    assert.equal(q("[data-org-history-skeleton]"), null);
    assert.ok(q('[data-org-history-empty="ready"]'));
    entries = fixture.entries;
    ready = false;
  });
});
