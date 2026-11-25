import { test } from "bun:test";
import assert from "node:assert/strict";
import { act } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { webBuilders } from "../../test-helpers/builders";
import { expectAbsent, expectPresent } from "../../test-helpers/domExpect";
import { mountWeb } from "../../test-helpers/mountWeb";
import { pending } from "../../test-helpers/testConvex";
import { HireRoleDialog } from "./HireRoleDialog";
import { ORG_FIXTURE } from "./orgFixture";

async function verifyHireFlow() {
  const copied: string[] = [];
  const builders = webBuilders("org template hire");
  const viewer = builders.teamMember.build({
    _id: "fixture-user-me" as Id<"users">,
  });
  const project = builders.project.build({
    _id: "project-1",
    title: "Product",
    workspace: "team:fixture-team",
  });
  const foreignProject = builders.project.build({
    title: "Other product",
    workspace: "team:other",
  });
  type Catalog = FunctionReturnType<typeof api.orgTemplates.catalog>;
  const manifest: Catalog[number]["manifest"] = {
    schemaVersion: 2,
    id: "growth",
    version: "2.0.0",
    name: "CMO",
    description: "One project CMO",
    role: {
      name: "CMO",
      handle: "{{instance}}-cmo",
      charter: "c.md",
      caps: { hands_per_day: 4, wakes_per_day: 12, tokens_per_day: 200000 },
    },
    inputs: [
      {
        key: "product.domain",
        label: "Apex domain",
        kind: "string",
        required: true,
      },
      { key: "accounts.ads", label: "Ads credentials", kind: "secret" },
    ],
    authority: [{ id: "site-write", kind: "write", label: "Ship pages" }],
    setup: [{ id: "sc", title: "Verify the domain", who: "human" }],
    routines: [{ id: "weekly", title: "Weekly", every: "7d", prompt: "w.md" }],
  };
  const catalog = [
    {
      template_id: "eng-lead",
      workspace: "codecast",
      name: "Engineering Lead",
      description: "Leads one project",
      latest: { version: "1.0.0", digest: "e".repeat(64) },
      latest_status: "stable" as const,
      installable: true,
      asks: { inputs: 0, secrets: 0, authority: 0, setup: 0, routines: 1 },
      manifest: {
        ...manifest,
        id: "eng-lead",
        name: "Engineering Lead",
        inputs: [],
        authority: [],
        setup: [],
        role: { ...manifest.role, handle: "{{instance}}-eng" },
      },
    },
    {
      template_id: "growth",
      workspace: "codecast",
      name: "CMO",
      description: "One project CMO",
      latest: { version: "2.0.0", digest: "a".repeat(64) },
      latest_status: "stable" as const,
      installable: true,
      asks: { inputs: 2, secrets: 1, authority: 1, setup: 1, routines: 1 },
      manifest,
    },
    {
      template_id: "draft",
      workspace: "team:fixture-team",
      name: "Draft role",
      description: "A release with no files",
      latest: { version: "0.1.0", digest: "b".repeat(64) },
      latest_status: "draft" as const,
      installable: false,
      asks: { inputs: 0, secrets: 0, authority: 0, setup: 0, routines: 1 },
      manifest: {
        ...manifest,
        id: "draft",
        inputs: [],
        authority: [],
        setup: [],
      },
    },
  ].map((entry): Catalog[number] => ({
    ...entry,
    avatar: null,
    latest_class: null,
    changelog: null,
    releases: [],
  }));
  type HireProps = Parameters<typeof HireRoleDialog>[0];
  const created: Parameters<HireProps["onCreate"]>[0][] = [];
  function mount(props: Partial<HireProps> = {}, leadProject?: string) {
    return mountWeb(
      <HireRoleDialog
        open
        onClose={() => {}}
        tree={ORG_FIXTURE}
        meId={viewer._id}
        initialProjects={[project]}
        projectPath="/src/product"
        onCreate={(input) => created.push(input)}
        {...props}
      />,
      {
        path: "/org",
        dispatch: true,
        setup(backend, store) {
          store.syncTable("currentUser", viewer);
          store.syncTable("clientState", {
            ui: { active_team_id: "fixture-team" },
          });
          store.syncTable("teams", [
            { _id: "fixture-team", name: "Product team" },
          ]);
          store.syncTable("projects", [project, foreignProject]);
          backend.set(api.org.scopeSummary, pending);
          backend.set(api.orgInit.takeoverPreview, pending);
          backend.set(api.orgTemplates.catalog, catalog);
          backend.set(api.orgTemplateLearning.learning, {
            enabled: false,
            can_change: true,
            changed_by: null,
          });
          backend.set(api.orgTemplates.instanceForRole, ({ role_id }) =>
            leadProject && String(role_id) === "lead-1"
              ? {
                  _id: "instance-1",
                  role_id,
                  template_id: "growth",
                  version: "2.0.0",
                  project_id: leadProject,
                }
              : null,
          );
          backend.mutation(api.dispatch.dispatch, null);
          backend.mutation(api.orgProposals.create, {
            short_id: "op-9",
            link: "/org?proposal=op-9",
          });
          Object.defineProperty(navigator, "clipboard", {
            value: {
              async writeText(text: string) {
                copied.push(text);
              },
            },
          });
        },
      },
    );
  }
  const web = await mount();
  const button = (text: string) => {
    const el = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent === text,
    );
    assert.ok(
      el,
      `Missing button "${text}". Rendered dialog: ${document.querySelector('[role="dialog"]')?.textContent ?? document.body.innerHTML}`,
    );
    return el;
  };
  button("From a template");
  const change = async (selector: string, value: string) => {
    const el = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      selector,
    )!;
    assert.ok(el, selector);
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype,
        "value",
      )!.set!.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  await change('input[placeholder="Head of Growth"]', "Growth lead");
  await change("textarea", "Keep my custom charter exactly.");
  await act(async () => button("From a template").click());
  assert.equal(button("Copy command").disabled, true);
  await change(
    'input[placeholder="/path/to/templates/growth"]',
    "/src/templates/growth",
  );
  await change('input[name="folder-instance"]', "product-growth");
  assert.equal(button("Copy command").disabled, false);
  assert.match(
    document.body.textContent!,
    /creates the role with its routines paused/,
  );
  assert.match(
    document.body.textContent!,
    /Spending and publishing need separate authorization/,
  );
  await act(async () => button("Copy command").click());
  assert.equal(copied.length, 1);
  assert.match(copied[0], /--project 'project-1'.*--team 'fixture-team'/);
  assert.equal(created.length, 0);
  assert.equal(
    document
      .querySelector("[data-hire-stage]")!
      .getAttribute("data-hire-stage"),
    "gallery",
  );
  const cards = [
    ...document.querySelectorAll<HTMLElement>("[data-template-card]"),
  ].map((el) => [el.dataset.templateCard, el.dataset.hireable]);
  assert.deepEqual(cards, [
    ["head-of-people", "true"],
    ["executive-assistant", "true"],
    ["eng-lead", "true"],
    ["growth", "true"],
    ["draft", "false"],
  ]);
  assert.ok(
    document.querySelector(
      '[data-template-card="eng-lead"] [data-template-card-leads]',
    ),
    "the default lead is badged",
  );
  assert.equal(
    document.querySelector(
      '[data-template-card="growth"] [data-template-card-leads]',
    ),
    null,
  );
  const growth = document.querySelector<HTMLElement>(
    '[data-template-card="growth"]',
  )!;
  assert.equal(
    growth.querySelector("[data-template-asks]")!.textContent,
    "Asks 1 answer · 1 secret · 1 permission · 1 setup step",
  );
  assert.match(growth.textContent!, /Weekly\s*weekly/);
  assert.doesNotMatch(growth.textContent!, /by Codecast|under the lead/);
  const draft = document.querySelector<HTMLElement>(
    '[data-template-card="draft"]',
  )!;
  assert.match(
    draft.querySelector("[data-template-card-reason]")!.textContent!,
    /Not ready to hire/,
  );
  assert.equal(draft.querySelector("[data-template-card-hire]"), null);
  assert.equal(
    document.querySelector("[data-template-form]"),
    null,
    "no form before a card is picked",
  );
  assert.equal(
    document
      .querySelector("[data-template-learning]")!
      .getAttribute("data-template-learning"),
    "false",
  );
  assert.match(
    document.querySelector("[data-template-learning]")!.textContent!,
    /generalized lessons about the template: never transcripts, quotes, names, customer data or code/,
  );
  await act(async () =>
    document
      .querySelector<HTMLElement>('[data-template-learning] [role="switch"]')!
      .click(),
  );
  assert.deepEqual(
    web.backend.mutations.map(({ name, args }) => {
      const { action, args: payload } = args as {
        action: string;
        args: unknown[];
      };
      return { name, action, payload };
    }),
    [
      {
        name: "dispatch:dispatch",
        action: "setOrgTemplateLearning",
        payload: ["fixture-team", true],
      },
    ],
  );
  await act(async () =>
    growth
      .querySelector<HTMLButtonElement>("[data-template-card-hire]")!
      .click(),
  );
  assert.equal(
    document
      .querySelector("[data-hire-stage]")!
      .getAttribute("data-hire-stage"),
    "form",
  );
  expectPresent(document.querySelector('[data-template-chosen="growth"]'));
  expectAbsent(document.querySelector(`option[value="${foreignProject._id}"]`));
  assert.equal(button("Propose the hire").disabled, true);

  await act(async () =>
    document.querySelector<HTMLButtonElement>("[data-template-back]")!.click(),
  );
  assert.ok(document.querySelector("[data-template-gallery]"));
  await act(async () =>
    document
      .querySelector<HTMLButtonElement>(
        '[data-template-card="growth"] [data-template-card-hire]',
      )!
      .click(),
  );
  assert.match(
    document.querySelector("[data-template-secrets]")!.textContent!,
    /^After you accept, on the role page, sealed to its machine: Ads credentials$/,
  );
  assert.equal(
    document.querySelector("[data-template-learning]"),
    null,
    "the workspace's learning switch stays on the gallery",
  );
  assert.match(
    document.body.textContent!,
    /Product has no lead yet, so this role would lead it/,
  );
  await act(async () =>
    document
      .querySelector<HTMLButtonElement>("[data-template-hire-lead-first]")!
      .click(),
  );
  assert.ok(document.querySelector('[data-template-chosen="eng-lead"]'));
  assert.equal(
    document.querySelector("[data-template-no-lead]"),
    null,
    "the lead template gets no nudge",
  );
  await act(async () =>
    document.querySelector<HTMLButtonElement>("[data-template-back]")!.click(),
  );
  await act(async () =>
    document
      .querySelector<HTMLButtonElement>(
        '[data-template-card="growth"] [data-template-card-hire]',
      )!
      .click(),
  );
  await change('input[name="input:product.domain"]', "product.example");
  assert.equal(
    document.querySelector<HTMLInputElement>('input[name="template-instance"]')!
      .value,
    "product-growth",
  );
  assert.match(
    document.body.textContent!,
    /A new role CMO @product-growth-cmo, reporting to me, leading Product, that starts work on its own/,
  );
  assert.match(
    document.body.textContent!,
    /Authority outside codecast: write \(Ship pages\)/,
  );
  assert.equal(button("Propose the hire").disabled, false);
  await act(async () =>
    document
      .querySelector("[data-template-form]")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  assert.equal(
    created.length,
    0,
    "a template hire never calls the manual create",
  );
  const proposed = web.backend.mutations
    .filter(({ name }) => name === "orgProposals:create")
    .map(({ args }) => args as FunctionArgs<typeof api.orgProposals.create>);
  assert.equal(proposed.length, 1);
  assert.deepEqual(
    proposed[0].changes.map((change: { kind: string }) => change.kind),
    ["role", "authority", "hire"],
  );
  assert.deepEqual(
    proposed[0].changes
      .filter((change: { kind: string }) => change.kind === "hire")
      .map(({ handle, template, version, project: projectRef, config }) => ({
        handle,
        template,
        version,
        projectRef,
        config,
      })),
    [
      {
        handle: "product-growth-cmo",
        template: "growth",
        version: "2.0.0",
        projectRef: project.short_id ?? project._id,
        config: { "product.domain": "product.example" },
      },
    ],
  );
  assert.equal(proposed[0].team_id, "fixture-team");
  assert.match(
    document.body.textContent!,
    /Proposed\. Nothing has changed yet\./,
  );
  assert.match(
    document.body.textContent!,
    /the role's page has one button left, Set up/,
  );
  assert.doesNotMatch(document.body.textContent!, /cast org template bind/);
  assert.ok(document.querySelector("[data-template-posted='op-9']"));
  await act(async () => button("Write a role").click());
  assert.equal(
    document.querySelector("textarea")!.value,
    "Keep my custom charter exactly.",
  );
  assert.equal(
    document.querySelector<HTMLInputElement>(
      'input[placeholder="Head of Growth"]',
    )!.value,
    "Growth lead",
  );
  assert.equal(button("Create and start").disabled, false);
  await act(async () => button("Create and start").click());
  assert.equal(created.length, 1);
  assert.equal(created[0].charter, "Keep my custom charter exactly.");
  assert.equal(created[0].caps, undefined);
  assert.equal(created[0].handle, "growth-lead");
  assert.equal(created[0].project_path, "/src/product");
  assert.equal(created[0].provision, true);
  assert.equal(
    "trust_stage" in created[0] ? created[0].trust_stage : undefined,
    undefined,
  );
  assert.deepEqual(created[0].scope, {
    project_ids: ["project-1"],
    plan_ids: [],
  });
  await act(async () => button("From a template").click());
  assert.ok(document.querySelector("[data-template-posted='op-9']"));
  assert.equal(document.querySelector("[data-template-form]"), null);
  await web.close();

  const lead = {
    ...ORG_FIXTURE.roles[0],
    _id: "lead-1",
    handle: "product-cmo",
    name: "CMO",
    status: "active" as const,
    scope: { project_ids: ["project-1"], plan_ids: [] },
  };
  const withLead = {
    ...ORG_FIXTURE,
    roles: [...ORG_FIXTURE.roles, lead],
  } satisfies typeof ORG_FIXTURE;
  const pickGrowth = async (leadProject: string) => {
    const again = await mount(
      { tree: withLead, initialMode: "template", onCreate: () => {} },
      leadProject,
    );
    const hire = document.querySelector<HTMLButtonElement>(
      '[data-template-card="growth"] [data-template-card-hire]',
    );
    expectPresent(hire);
    await act(async () => hire.click());
    return again;
  };
  const elsewhere = await pickGrowth("another-project");
  assert.equal(
    document
      .querySelector("[data-template-lead]")!
      .getAttribute("data-lead-runs"),
    "elsewhere",
  );
  assert.equal(
    document
      .querySelector<HTMLInputElement>('input[name="template-seat"]:checked')!
      .parentElement!.textContent!.startsWith("Give it to @product-cmo"),
    true,
    "the lead that runs this template is the default seat",
  );
  await elsewhere.close();
  const here = await pickGrowth(project._id);
  assert.equal(
    document
      .querySelector("[data-template-lead]")!
      .getAttribute("data-lead-runs"),
    "here",
  );
  assert.equal(document.querySelector('input[name="template-seat"]'), null);
  assert.match(
    document.querySelector("[data-template-lead]")!.textContent!,
    /@product-cmo leads Product and already runs CMO 2\.0\.0 here\./,
  );
  assert.equal(
    document.querySelector("[data-template-open-lead]")!.getAttribute("href"),
    "/org/or-1",
  );
  assert.equal(
    document.querySelector("[data-template-inputs]"),
    null,
    "nothing is asked when there is nothing to hire",
  );
  assert.equal(
    [...document.querySelectorAll("button")].some(
      (b) => b.textContent === "Propose the hire",
    ),
    false,
    "no hire button when there is nothing to hire",
  );
  await here.close();
}

test(
  "proposes hires and hides the action when no seat can be hired",
  verifyHireFlow,
);
