import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import { api } from "@codecast/convex/convex/_generated/api";
import React, { act, type ComponentProps } from "react";
import { webBuilders } from "../../../test-helpers/builders";
import { expectAbsent, expectPresent } from "../../../test-helpers/domExpect";
import { mountWeb } from "../../../test-helpers/mountWeb";
import { pending } from "../../../test-helpers/testConvex";
import { expectToast } from "../../../test-helpers/expectToast";
import { waitForPopupClose } from "../../../test-helpers/waitForPopupClose";
import { InboxSelectionBar } from "../../BulkMoveSessions";
import { LineStartSwitch } from "../../line/map/LineStartSwitch";
import { PermissionStackView } from "../../PermissionCard";
import { MergeMenu } from "../../pr/PRActions";
import { TeamSharingNudgeBanner } from "../../TeamSharingNudgeBanner";

const ids = webBuilders("sites.mount.test.tsx");
const q = <T extends Element = HTMLElement>(sel: string) =>
  document.querySelector<T>(sel);
const click = (selector: string) =>
  act(async () => {
    const button = q(selector);
    expectPresent(button);
    button.click();
  });

test("Allow all: the button opens the review of switching a session's prompts off; the review's button does it", async () => {
  const calls: string[] = [];
  const pending = [
    {
      _id: "p1",
      tool_name: "Bash",
      arguments_preview: "ls",
      status: "pending" as const,
    },
    {
      _id: "p2",
      tool_name: "Bash",
      arguments_preview: "pwd",
      status: "pending" as const,
    },
  ];
  await mountWeb(
    React.createElement(PermissionStackView, {
      pending,
      inflight: new Set<string>(),
      onApprove: () => {},
      onDeny: () => {},
      onApproveAll: () => calls.push("approveAll"),
      onDenyAll: () => {},
      onAllowAll: () => calls.push("allowAll"),
    }),
  );
  await click("[data-allow-all]");
  assert.deepEqual(calls, [], "the button alone bypasses nothing");
  assert.equal(q('[data-switch-figure="approved now"]')!.textContent, "2");
  assert.match(q('[data-switch-row="Asks first"]')!.textContent!, /Never/);
  await click("[data-switch-cancel]");
  await waitForPopupClose();
  assert.deepEqual(calls, []);
  await click("[data-allow-all]");
  await click("[data-switch-confirm]");
  assert.deepEqual(calls, ["allowAll"]);
});

test("the line's start switch: off, a press opens the review with the line's own numbers; on, a press turns it off", async () => {
  const calls: string[] = [];
  const role = ids.role.build({ handle: "quality", trust: "direct" });
  const project = ids.project.build();
  const admit = (
    on: boolean,
  ): ComponentProps<typeof LineStartSwitch>["admit"] => ({
    admission: {
      role: { id: role._id, handle: role.handle, paused: false },
      on,
      queued: 60,
      slots: 5,
      busy: 0,
      hands: 0,
      handsCap: 6,
    },
    role: { ...role, scope: { project_ids: [project._id], plan_ids: [] } },
    setOn: (v: boolean) => calls.push(`setOn:${v}`),
    setSlots: () => {},
  });
  const web = await mountWeb(
    React.createElement(LineStartSwitch, {
      admit: admit(false),
      waiting: 77,
      ready: 60,
      notReady: [{ count: 17, words: "a fix to decide" }],
      projectId: project._id,
    }),
    { setup: (backend) => backend.set(api.org.roles, pending) },
  );
  await click("[data-line-start-switch]");
  assert.deepEqual(calls, [], "the switch alone starts nothing");
  assert.equal(
    q('[data-switch-figure="start within 2 min"]')!.textContent,
    "5",
  );
  assert.equal(q('[data-switch-figure="ready"]')!.textContent, "60");
  assert.match(q("[data-switch-confirm]")!.textContent!, /Turn on: run all 60/);
  await click("[data-switch-confirm]");
  assert.deepEqual(calls, ["setOn:true"]);

  await waitForPopupClose();
  await web.rerender(
    React.createElement(LineStartSwitch, {
      admit: admit(true),
      projectId: project._id,
    }),
  );
  await click("[data-line-start-switch]");
  assert.deepEqual(
    calls,
    ["setOn:true", "setOn:false"],
    "turning off is one press",
  );
  expectAbsent(q("[data-switch-review]"));
});

test("the sharing banner: its button opens the review of who then reads what; the review's button raises the level", async () => {
  const team = {
    _id: ids.teamMember.build()._id,
    name: "Union",
    member_count: 5,
    shared_project_count: 2,
    visibility: "summary",
  };
  const unrelated = {
    _id: ids.teamMember.build()._id,
    name: "Solo",
    member_count: 1,
    shared_project_count: 2,
    visibility: "summary",
  };
  const web = await mountWeb(<TeamSharingNudgeBanner />, {
    dispatch: true,
    setup(backend, store) {
      store.syncTable("teams", [unrelated, team]);
      backend.mutation(api.dispatch.dispatch, null);
    },
  });
  const visibilityWrites = () =>
    web.backend.mutations.filter(
      ({ args }) =>
        typeof args === "object" &&
        args !== null &&
        "action" in args &&
        args.action === "setTeamMembershipVisibility",
    );
  await click("[data-share-in-full]");
  assert.deepEqual(
    visibilityWrites(),
    [],
    "the banner's button alone shares nothing",
  );
  assert.equal(q('[data-switch-figure="teammates read"]')!.textContent, "4");
  await click("[data-switch-confirm]");
  await expectToast(
    "success",
    "Union sees the whole conversation for new sessions",
  );
  assert.equal(visibilityWrites().length, 1);
  const [write] = visibilityWrites();
  expect(write).toMatchObject({
    name: "dispatch:dispatch",
    args: { args: [team._id, "full", "going_forward"] },
  });
});

test("PR merge: the button opens the review of what lands where; only the review's button merges", async () => {
  const pr = {
    state: "open",
    repository: "acme/app",
    number: 42,
    title: "Fix login",
    base_ref: "main",
    head_ref: "fix-login",
    head_sha: "ab42c01",
    changed_files: 3,
    additions: 40,
    deletions: 2,
    checks_state: "success",
    mergeable: true,
  };
  const web = await mountWeb(<MergeMenu pr={pr} />, {
    setup(backend) {
      backend.action(api.prCli.merge, { merged: true });
    },
  });
  const merged = web.backend.actions;
  await click("[data-pr-merge]");
  expect(merged, "the button alone merges nothing").toEqual([]);
  assert.match(
    q("[data-switch-review]")!.textContent!,
    /Merge #42.*Open.*Merged/,
  );
  assert.equal(q('[data-switch-figure="lands on"]')!.textContent, "main");
  assert.match(q("[data-switch-confirm]")!.textContent!, /Merge into main/);
  await click("[data-switch-confirm]");
  await expectToast("success", "Merged");
  assert.equal(merged.length, 1);
  expect(merged).toEqual([
    {
      name: "prCli:merge",
      args: {
        number: 42,
        repository: "acme/app",
        expected_head_sha: "ab42c01",
        method: "squash",
        delete_branch: true,
      },
    },
  ]);
});

test("PR bypass: offered only when GitHub says this person may bypass; only the review's button merges past protection", async () => {
  let canBypass = false;
  const openMenu = async () => {
    const options = q('[aria-label="Merge options"]');
    expectPresent(options);
    await act(async () =>
      options.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          ctrlKey: false,
        }),
      ),
    );
  };
  const pr = {
    state: "open",
    repository: "acme/app",
    number: 7,
    title: "Ship it",
    base_ref: "main",
    head_ref: "ship",
    head_sha: "abc1234",
    checks_state: "pending",
    mergeable: true,
    mergeable_state: "blocked",
  };

  const web = await mountWeb(<MergeMenu pr={pr} />, {
    setup(backend) {
      backend.action(api.prCli.mergeAccess, () => ({
        held: true,
        can_bypass: canBypass,
        merge_state: "BLOCKED",
        as: "alexfgreen",
      }));
      backend.action(api.prCli.merge, { merged: true });
    },
  });
  const merges = () =>
    web.backend.actions.filter(({ name }) => name === "prCli:merge");
  assert.equal(
    (q("[data-pr-merge]") as HTMLButtonElement).disabled,
    true,
    "a held merge has no plain button",
  );
  await openMenu();
  expectPresent(q("[data-pr-auto-merge]"), "the menu opened");
  assert.equal(
    q("[data-pr-merge-bypass]"),
    null,
    "nobody without the right is offered it",
  );

  await act(async () => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  await waitForPopupClose();
  canBypass = true;
  await web.rerender(<MergeMenu pr={{ ...pr, head_sha: "def5678" }} />);
  await openMenu();
  expectPresent(q("[data-pr-merge-bypass]"));
  await act(async () => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  await waitForPopupClose();
  const access = Promise.withResolvers<{
    held: boolean;
    can_bypass: boolean;
    merge_state: string;
    as: string;
  }>();
  web.backend.action(api.prCli.mergeAccess, () => access.promise);
  await web.rerender(<MergeMenu pr={{ ...pr, head_sha: "def5679" }} />);
  await openMenu();
  expectPresent(q("[data-pr-auto-merge]"));
  expectAbsent(q("[data-pr-merge-bypass]"));
  await act(async () => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    access.resolve({
      held: true,
      can_bypass: true,
      merge_state: "BLOCKED",
      as: "alexfgreen",
    });
  });
  await waitForPopupClose();
  await openMenu();
  await click("[data-pr-merge-bypass]");
  assert.equal(merges().length, 0, "the item alone merges nothing");
  const review = q("[data-switch-review]")!.textContent!;
  assert.match(review, /Bypass and merge #7/);
  assert.match(review, /Bypasses branch protection/);
  assert.match(review, /Required checks and reviews/);
  assert.match(review, /alexfgreen/);
  await click("[data-switch-confirm]");
  await expectToast("success", "Merged past protection");
  assert.equal(merges().length, 1);
  expect(merges()).toEqual([
    {
      name: "prCli:merge",
      args: {
        repository: "acme/app",
        number: 7,
        bypass: true,
        expected_head_sha: "def5679",
        method: "squash",
        delete_branch: true,
      },
    },
  ]);
});

test("bulk kill: idle sessions end at once; a selection with working ones opens the review first", async () => {
  const killed: string[][] = [];
  const idle = ids.session.build({ title: "Idle one", is_idle: true });
  const busy = ids.session.build({ title: "Busy one", is_idle: false });
  const web = await mountWeb(
    React.createElement(InboxSelectionBar, {
      sessions: [idle],
      onKill: (ids: string[]) => killed.push(ids),
      onClear: () => {},
    }),
  );
  await click("[data-bulk-kill]");
  assert.deepEqual(
    killed,
    [[idle._id]],
    "nothing mid-turn: one press, restore undoes it",
  );
  expectAbsent(q("[data-switch-review]"));

  const mixed = [idle, busy];
  await web.rerender(
    React.createElement(InboxSelectionBar, {
      sessions: mixed,
      onKill: (ids: string[]) => killed.push(ids),
      onClear: () => {},
    }),
  );
  await click("[data-bulk-kill]");
  assert.equal(
    killed.length,
    1,
    "a working session in the selection: the press asks first",
  );
  assert.equal(q('[data-switch-figure="cut off"]')!.textContent, "1");
  assert.match(q('[data-switch-row="Working"]')!.textContent!, /Busy one/);
  await click("[data-switch-confirm]");
  assert.deepEqual(killed[1], [idle._id, busy._id]);
});
