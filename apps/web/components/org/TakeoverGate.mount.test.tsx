import { api } from "@codecast/convex/convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { act, type ReactNode } from "react";
import { webBuilders } from "../../test-helpers/builders";
import { expectAbsent, expectPresent } from "../../test-helpers/domExpect";
import { mountWeb } from "../../test-helpers/mountWeb";
import { pending } from "../../test-helpers/testConvex";
import { waitForPopupClose } from "../../test-helpers/waitForPopupClose";
import { TakeoverGate } from "./TakeoverEdit";
import { GatedScopeEditor } from "./scope/ScopeEditors";
import { ORG_FIXTURE } from "./orgFixture";

const fixtures = webBuilders("TakeoverGate.mount.test.tsx");
type Preview = FunctionReturnType<typeof api.orgInit.takeoverPreview>;
let answer: Preview | typeof pending;

const WS = { kind: "team" as const, id: "fixture-team", name: "Acme" };
const moves = (n: number): Preview => [
  {
    sessions: Array.from({ length: n }, (_, i) => `jx7000${i}`),
    kept_in_front: [],
    over_cap: 0,
    phrase: "",
  },
];
let web: Awaited<ReturnType<typeof mountWeb>>;
const mount = async (node: ReactNode) => {
  web = await mountWeb(node, {
    path: "/org/or-1",
    setup(backend, store) {
      store.syncTable("currentUser", { _id: "fixture-user-me" });
      store.syncTable("clientState", { ui: { active_team_id: WS.id } });
      store.syncTable("orgTree", ORG_FIXTURE);
      store.syncTable("projects", [
        fixtures.project.build({
          _id: "p-growth",
          title: "Growth",
          workspace: "team:fixture-team",
        }),
        fixtures.project.build({
          _id: "p-billing",
          title: "Billing",
          workspace: "team:fixture-team",
        }),
        fixtures.project.build({
          _id: "p-outside",
          title: "Private project",
          workspace: "team:away",
        }),
      ]);
      backend.set(api.orgInit.takeoverPreview, answer);
    },
  });
};
const asked = () =>
  web.backend.queryRequests
    .filter(({ name }) => name === "orgInit:takeoverPreview")
    .map(({ args }) => args);
const q = <T extends Element = HTMLElement>(sel: string) =>
  document.querySelector<T>(sel);

describe("TakeoverGate", () => {
  it("nothing would move: it confirms itself, once, with no edit, and shows nothing", async () => {
    answer = [null];
    const confirmed: unknown[] = [];
    await mount(
      <TakeoverGate
        workspace={WS}
        ask={{ handle: "growth", add: ["project:p-growth"] }}
        what="x"
        confirmLabel="Go"
        onConfirm={(o) => confirmed.push(o)}
        onCancel={() => {}}
      />,
    );
    assert.deepEqual(confirmed, [{ leave_sessions: false }]);
    assert.equal(q("[data-takeover-gate]"), null);
  });

  it("until the server answers, the write waits and the button is off", async () => {
    answer = pending;
    const confirmed: unknown[] = [];
    await mount(
      <TakeoverGate
        workspace={WS}
        ask={{ handle: "growth", add: ["project:p-growth"] }}
        what="Growth joins @growth"
        confirmLabel="Go"
        onConfirm={(o) => confirmed.push(o)}
        onCancel={() => {}}
      />,
    );
    assert.equal(
      q("[data-takeover-gate]")!.getAttribute("data-takeover-gate"),
      "counting",
    );
    assert.equal(
      q<HTMLButtonElement>("[data-takeover-confirm]")!.disabled,
      true,
    );
    assert.deepEqual(confirmed, []);
  });

  it("sessions would move: the sentence, the one edit, and the person's own press", async () => {
    answer = moves(3);
    const confirmed: unknown[] = [];
    let cancelled = 0;
    await mount(
      <TakeoverGate
        workspace={WS}
        ask={{ handle: "growth", add: ["project:p-growth"] }}
        what="Growth joins @growth"
        confirmLabel="Go"
        onConfirm={(o) => confirmed.push(o)}
        onCancel={() => cancelled++}
      />,
    );
    assert.deepEqual(asked().at(-1), {
      team_id: "fixture-team",
      items: [{ handle: "growth", add: ["project:p-growth"] }],
    });
    assert.deepEqual(confirmed, [], "a takeover never confirms itself");
    assert.match(
      q("[data-takeover-phrase]")!.textContent!,
      /^3 sessions now report to @growth and leave Needs You\.$/,
    );
    await act(async () =>
      q<HTMLInputElement>("[data-takeover-leave-input]")!.click(),
    );
    await act(async () =>
      q<HTMLButtonElement>("[data-takeover-confirm]")!.click(),
    );
    await act(async () =>
      q<HTMLButtonElement>("[data-takeover-confirm]")?.click(),
    );
    assert.deepEqual(
      confirmed,
      [{ leave_sessions: true }],
      "one write, however many presses",
    );
    await act(async () =>
      q<HTMLButtonElement>("[data-takeover-cancel]")!.click(),
    );
    assert.equal(cancelled, 1);
  });
});

describe("GatedScopeEditor", () => {
  const role = {
    ...ORG_FIXTURE.roles[0],
    handle: "growth",
    scope: { project_ids: ["p-growth"], plan_ids: [] },
    scope_names: { projects: [{ id: "p-growth", title: "Growth" }], plans: [] },
  };
  const pick = async (value: string) =>
    act(async () => {
      const select = q<HTMLSelectElement>(
        'select[aria-label="Add to its area"]',
      )!;
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

  it("a gain that moves sessions shows in the editor at once and is written only after the person confirms", async () => {
    answer = moves(2);
    const writes: unknown[][] = [];
    await mount(
      <GatedScopeEditor
        workspace={WS}
        role={role}
        canEdit
        onChange={(...a) => writes.push(a)}
      />,
    );
    expectAbsent(q('select option[value="project:p-outside"]'));
    expectPresent(q('select option[value="project:p-billing"]'));
    await pick("project:p-billing");
    assert.ok(
      q('[data-scope-project="p-billing"]'),
      "the pending project is painted",
    );
    assert.deepEqual(writes, []);
    assert.match(
      q("[data-takeover-phrase]")!.textContent!,
      /^2 sessions now report to @growth/,
    );
    await act(async () =>
      q<HTMLButtonElement>("[data-takeover-confirm]")!.click(),
    );
    assert.deepEqual(writes, [
      [{ project_ids: ["p-growth", "p-billing"], plan_ids: [] }, undefined],
    ]);
    assert.equal(q("[data-takeover-gate]"), null);
  });

  it("leave the sessions rides the write; cancel drops the pending gain", async () => {
    answer = moves(2);
    const writes: unknown[][] = [];
    await mount(
      <GatedScopeEditor
        workspace={WS}
        role={role}
        canEdit
        onChange={(...a) => writes.push(a)}
      />,
    );
    await pick("project:p-billing");
    await act(async () =>
      q<HTMLButtonElement>("[data-takeover-cancel]")!.click(),
    );
    assert.equal(q('[data-scope-project="p-billing"]'), null);
    assert.deepEqual(writes, []);
    await waitForPopupClose();
    await pick("project:p-billing");
    await act(async () =>
      q<HTMLInputElement>("[data-takeover-leave-input]")!.click(),
    );
    await act(async () =>
      q<HTMLButtonElement>("[data-takeover-confirm]")!.click(),
    );
    assert.deepEqual(writes, [
      [
        { project_ids: ["p-growth", "p-billing"], plan_ids: [] },
        { leave_sessions: true },
      ],
    ]);
  });

  it("a gain that moves nothing, and an edit that only removes, are written without a question", async () => {
    answer = [null];
    const writes: unknown[][] = [];
    await mount(
      <GatedScopeEditor
        workspace={WS}
        role={role}
        canEdit
        onChange={(...a) => writes.push(a)}
      />,
    );
    await pick("project:p-billing");
    assert.deepEqual(writes, [
      [{ project_ids: ["p-growth", "p-billing"], plan_ids: [] }, undefined],
    ]);
    const before = asked().length;
    await act(async () =>
      q<HTMLButtonElement>('[data-scope-project="p-growth"] button')!.click(),
    );
    assert.deepEqual(writes.at(-1), [{ project_ids: [], plan_ids: [] }]);
    assert.equal(asked().length, before, "a removal asks the server nothing");
  });
});
