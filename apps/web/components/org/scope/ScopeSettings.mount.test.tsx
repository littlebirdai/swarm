import { expectAbsent } from "../../../test-helpers/domExpect";
import { api } from "@codecast/convex/convex/_generated/api";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { act } from "react";
import { webBuilders } from "../../../test-helpers/builders";
import { mountWeb } from "../../../test-helpers/mountWeb";
import { pending } from "../../../test-helpers/testConvex";
import { ORG_FIXTURE } from "../orgFixture";
import type { OrgRole, OrgTree } from "../orgTypes";
import { ScopeSettings } from "./ScopeSettings";

const fixtures = webBuilders("ScopeSettings.mount.test.tsx");
const viewer = fixtures.teamMember.build();
const growth = fixtures.role.build({
  host_user_id: viewer._id,
  name: "Head of Growth",
  handle: "head-of-growth",
  status: "active",
});
const rootRole = fixtures.role.build({
  host_user_id: viewer._id,
  handle: "head-of-people",
  name: "Head of People",
  status: "active",
});
const tree: OrgTree = { ...ORG_FIXTURE, roles: [growth, rootRole] };

const q = <T extends Element = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector);

function setup() {
  const calls: string[] = [];
  let mount: Awaited<ReturnType<typeof mountWeb>> | undefined;
  const render = async (role: OrgRole, canEdit = true) => {
    const node = (
      <ScopeSettings
        tree={tree}
        role={role}
        canEdit={canEdit}
        overlaps={[]}
        hostName="Ashot"
        model={null}
        standingId={null}
        counters={{ day: "2026-09-23", hands: 1, wakes: 2, tokens: 3 }}
        onUpdate={(fields) => calls.push(`update:${JSON.stringify(fields)}`)}
        onReparent={() => {}}
      />
    );
    if (mount) {
      await mount.rerender(node);
      return;
    }
    mount = await mountWeb(node, {
      path: `/org/roles/${role.short_id}?tab=settings`,
      setup: (backend, store) => {
        store.syncTable("currentUser", viewer);
        backend.set(api.orgRoles.line, pending);
        backend.set(api.workflows.webList, []);
        backend.set(api.accountSwitch.listAccountProfiles, { devices: [] });
      },
    });
  };
  return {
    calls,
    render,
    text: () => document.body.textContent ?? "",
    store: () => {
      assert.ok(mount);
      return mount.store.getState();
    },
  };
}

test("the role identity shows its name and handle and saves edits", async () => {
  const { render, calls } = setup();
  await render(growth);

  async function edit(current: string, replacement: string) {
    const button = [...document.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === current,
    );
    assert.equal(button?.textContent, current);
    await act(async () => button!.click());
    const field = document.activeElement;
    assert.ok(
      field instanceof HTMLInputElement,
      "The editor focuses its input",
    );
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      set.call(field, replacement);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      field.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
  }

  await edit("Head of Growth", "Growth lead");
  await edit("head-of-growth", "@growth-lead");
  assert.deepEqual(calls, [
    'update:{"name":"Growth lead"}',
    'update:{"handle":"growth-lead"}',
  ]);
});

test("hire leeway requires confirmation to turn on and turns off immediately", async () => {
  const { render, calls } = setup();
  await render({ ...growth, trust: "direct" });
  const hires = () => q<HTMLButtonElement>("[data-hire-leeway-switch]")!;
  assert.equal(hires().getAttribute("data-hire-leeway-switch"), "off");
  const hiresBefore = calls.length;
  await act(async () => {
    hires().click();
  });
  assert.equal(
    calls.length,
    hiresBefore,
    "the switch alone lets it hire nothing",
  );
  assert.equal(
    q("[data-switch-review]")!.getAttribute("data-switch-review"),
    "Hires without approval",
  );
  assert.ok(document.querySelector('[data-switch-figure="approvals a hire"]'));
  await act(async () => {
    document.querySelector<HTMLButtonElement>("[data-switch-confirm]")!.click();
  });
  assert.equal(calls.pop(), 'update:{"hires_freely":true}');
  await render({ ...growth, trust: "direct", hires_freely: true });
  assert.equal(hires().getAttribute("data-hire-leeway-switch"), "on");
  await act(async () => {
    hires().click();
  });
  assert.equal(calls.pop(), 'update:{"hires_freely":false}');
  await render({ ...growth, trust: "direct" }, false);
  assert.ok(hires().disabled, "a viewer who cannot edit reads it");
});

test("containment changes in one press and requires an area", async () => {
  const { render, calls } = setup();
  const scoped: OrgRole = {
    ...growth,
    trust: "direct",
    scope: { project_ids: ["pz"], plan_ids: [] },
  };
  await render(scoped);
  const keeps = () =>
    q<HTMLButtonElement>("[data-keeps-reports-inside-switch]");
  assert.equal(
    keeps()!.getAttribute("data-keeps-reports-inside-switch"),
    "off",
  );
  assert.equal(
    keeps()!.getAttribute("aria-haspopup"),
    null,
    "it flips at once, with no review",
  );
  await act(async () => {
    keeps()!.click();
  });
  assert.equal(calls.pop(), 'update:{"keeps_reports_inside":true}');
  await render({ ...scoped, keeps_reports_inside: true });
  assert.equal(keeps()!.getAttribute("data-keeps-reports-inside-switch"), "on");
  await act(async () => {
    keeps()!.click();
  });
  assert.equal(calls.pop(), 'update:{"keeps_reports_inside":false}');
  await render({
    ...growth,
    trust: "direct",
    scope: { project_ids: [], plan_ids: [] },
  });
  expectAbsent(keeps(), "a role with no area holds nothing");
});

test("autonomy turns off immediately and requires confirmation to turn on", async () => {
  const { render, calls, text } = setup();
  await render({ ...growth, trust: "direct" });
  const sw = q<HTMLButtonElement>("[data-autonomy-switch]")!;
  assert.equal(sw.getAttribute("data-autonomy-switch"), "on");
  assert.equal(sw.getAttribute("aria-checked"), "true");
  assert.equal(sw.getAttribute("aria-label"), "Starts work on its own");
  assert.ok(!sw.disabled);
  await act(async () => {
    sw.click();
  });
  assert.equal(calls.pop(), 'update:{"trust":"understand"}');
  // decide reads as on (S23.1).
  await render({ ...growth, trust: "decide" });
  assert.equal(
    q("[data-autonomy-switch]")!.getAttribute("data-autonomy-switch"),
    "on",
  );
  // Off: the hint says the person starts the work; a click opens the review of what the role may then do, and the review's own button turns it on.
  await render({ ...growth, trust: "understand" });
  assert.equal(
    q("[data-autonomy-switch]")!.getAttribute("data-autonomy-switch"),
    "off",
  );
  assert.match(text(), /you start the work, or turn this on/);
  const before = calls.length;
  await act(async () => {
    q<HTMLButtonElement>("[data-autonomy-switch]")!.click();
  });
  assert.equal(calls.length, before, "the switch alone turns nothing on");
  // A role with no daily limit of its own has none, and the review says so.
  assert.ok(
    document.querySelector('[data-switch-figure="a day, no limit"]'),
    "the review leads with the role's daily sessions",
  );
  await act(async () => {
    document.querySelector<HTMLButtonElement>("[data-switch-confirm]")!.click();
  });
  assert.equal(calls.pop(), 'update:{"trust":"direct"}');
});

test("limits start closed and show usage without internal terms", async () => {
  const { render, text } = setup();
  await render({ ...growth, trust: "understand" });
  const limits = q<HTMLDetailsElement>("[data-role-limits]")!;
  assert.ok(limits, "the Limits disclosure exists");
  assert.equal(
    limits.open,
    false,
    "closed by default: the role page shows no numbers",
  );
  const inputs = [
    ...limits.querySelectorAll<HTMLInputElement>("input[type=number]"),
  ].map((i) => i.value);
  assert.deepEqual(
    inputs,
    ["", "", ""],
    "a role with none of its own has no limit",
  );
  assert.ok(
    [...limits.querySelectorAll<HTMLInputElement>("input[type=number]")].every(
      (i) => i.placeholder === "no limit",
    ),
  );
  assert.match(limits.textContent!, /today 1/);
  assert.match(text(), /none unless you set one/);

  assert.doesNotMatch(
    text(),
    /trust|stage|\bcaps?\b|budget|allowance|understand|decide|direct/i,
  );
});

test("the root role can turn on autonomy", async () => {
  const { render } = setup();
  await render({ ...rootRole, trust: "understand" });
  const rs = q<HTMLButtonElement>("[data-autonomy-switch]")!;
  assert.equal(rs.getAttribute("data-autonomy-switch"), "off");
  assert.ok(!rs.disabled, "the root's switch can be turned on");
});

test("the workflow link opens the stations for the selected line", async () => {
  const { render, store } = setup();
  await render({ ...growth, trust: "direct" });
  const edit = q<HTMLAnchorElement>("a[data-line-edit-link]")!;
  assert.ok(edit, "the Workflow section links to line settings");
  assert.match(
    edit.getAttribute("href")!,
    /^\/flows\/settings\?(project=[^&]+&)?section=stations$/,
  );
  expectAbsent(
    q("[data-line-customized-note]"),
    "the shipped line is not called customized",
  );
  await act(async () => {
    store().syncTable("projects", [
      fixtures.project.build({
        short_id: "pr-9",
        title: "Atlas",
        workspace: `user:${viewer._id}`,
      }),
    ]);
  });
  await render({
    ...growth,
    trust: "direct",
    line_workflow_slug: "line-pr-9",
  });
  assert.equal(
    q("[data-line-customized-note]")?.textContent,
    "Atlas's customized steps",
  );
  assert.equal(
    q<HTMLAnchorElement>("a[data-line-edit-link]")!.getAttribute("href"),
    "/flows/settings?project=pr-9&section=stations",
  );
});

test("a viewer without edit access can read the autonomy switch", async () => {
  const { render } = setup();
  await render({ ...growth, trust: "direct" }, false);
  assert.ok(q<HTMLButtonElement>("[data-autonomy-switch]")!.disabled);
});
