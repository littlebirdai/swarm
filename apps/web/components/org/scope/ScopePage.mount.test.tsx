import { expectAbsent } from "../../../test-helpers/domExpect";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { api } from "@codecast/convex/convex/_generated/api";
import type { BriefHand, ScopeSummary } from "@codecast/convex/convex/org";
import { afterAll, afterEach, mock, spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import * as React from "react";
import { act } from "react";
import type { DispatchCallArgs } from "../../../lib/dispatch-binding";
import {
  useInboxStore,
  type InboxSession,
  type PlanItem,
  type ProjectItem,
  type TaskItem,
} from "../../../store/inboxStore";
import { webBuilders } from "../../../test-helpers/builders";
import { ConversationLayoutStandIn } from "../../../test-helpers/ConversationLayoutStandIn";
import { mountWeb } from "../../../test-helpers/mountWeb";
import { pending } from "../../../test-helpers/testConvex";
import { waitForDom } from "../../../test-helpers/waitForDom";
import { ORG_FIXTURE } from "../orgFixture";
import type { OrgRole, OrgSession, OrgTree } from "../orgTypes";

const fixtures = webBuilders("ScopePage.mount.test.tsx");
const TEAM = "s".repeat(32);
const T0 = Math.floor(Date.now() / 3_600_000) * 3_600_000;

let restoreClock: (() => void) | undefined;
afterEach(() => {
  restoreClock?.();
  restoreClock = undefined;
});

function world() {
  const clock = spyOn(Date, "now").mockReturnValue(T0);
  restoreClock = () => clock.mockRestore();
  const env = {
    phone: false,
    wide: true,
    qs: "",
    tree: ORG_FIXTURE,
    summary: undefined as ScopeSummary | undefined,
  };
  const state = {
    currentUser: { _id: "fixture-user-me" },
    sessions: {} as Record<
      string,
      Partial<InboxSession> & { _id: string; active_task_id?: string }
    >,
  };
  const collections = {
    projects: [] as Partial<ProjectItem>[],
    plans: [] as Partial<PlanItem>[],
    tasks: [] as Partial<TaskItem>[],
  };
  let web: Awaited<ReturnType<typeof mountWeb>>;
  const openCalls: string[] = [];
  const seed = (store: ReturnType<typeof useInboxStore.getState>) => {
    const stamp = { workspace: "team:" + TEAM, team_id: TEAM };
    store.syncTable("currentUser", state.currentUser);
    const standingIds = [
      ...env.tree.roles.map((role) => role.standing?.conversation_id),
      ...env.tree.anchors.map((anchor) => anchor.conversation_id),
    ];
    for (const id of standingIds) {
      if (!id) continue;
      store.syncRecord("conversations", id, {
        _id: id,
        is_own: false,
        updated_at: T0,
      });
      store.setMessages(id, [fixtures.message.build()]);
    }
    store.syncTable("clientState", { ui: { active_team_id: TEAM } });
    store.syncTable("teams", [{ _id: TEAM, name: "Codecast" }]);
    store.syncTable("orgTree", {
      ...env.tree,
      workspace: { ...env.tree.workspace, id: TEAM },
    });
    store.syncTable(
      "sessions",
      Object.values(state.sessions).map((row) => fixtures.session.build(row)),
    );
    store.syncTable(
      "projects",
      collections.projects.map((row) =>
        fixtures.project.build({ ...row, ...stamp }),
      ),
    );
    store.syncTable(
      "plans",
      collections.plans.map((row) => fixtures.plan.build({ ...row, ...stamp })),
    );
    store.syncTable(
      "tasks",
      collections.tasks.map((row) => fixtures.task.build({ ...row, ...stamp })),
    );
  };
  const mountNode = async (node: React.ReactNode, path = "/org/or-1") => {
    await web?.close();
    web = await mountWeb(node, {
      path,
      dispatch: true,
      setup: (backend, store) => {
        backend.mutation(api.dispatch.dispatch, null);
        const query = window.matchMedia;
        window.matchMedia = (media) => ({
          ...query(media),
          matches: env.phone
            ? media === "(max-width: 767px)"
            : media.startsWith("(min-width:") && env.wide,
        });
        const measure = window.HTMLElement.prototype.getBoundingClientRect;
        window.HTMLElement.prototype.getBoundingClientRect = function () {
          const rect = measure.call(this);
          return this.hasAttribute("data-scope-page") && !env.wide
            ? { ...rect, width: 600, right: 600 }
            : rect;
        };
        seed(store);
        useInboxStore.setState({ clientStateInitialized: true });
        backend.set(api.conversations.getConversation, pending);
        backend.set(api.conversations.getConversationWithMeta, pending);
        backend.set(api.conversations.getTranscriptWatermark, pending);
        backend.set(api.conversations.getUserMessages, pending);
        backend.set(api.conversations.listMessagesTail, pending);
        backend.set(api.conversations.getAllMessages, pending);
        backend.set(api.org.tree, pending);
        backend.set(api.org.roles, pending);
        backend.set(api.org.scopeSummary, env.summary);
        backend.set(api.org.scopeFeed, { rows: [] });
        backend.set(api.workflow_runs.listRuns, pending);
        backend.set(api.artifacts.listForWeb, pending);
        backend.set(api.org.brief, pending);
        backend.set(api.anchors.getAnchorSpace, pending);
        backend.set(api.users.getRecentProjectPaths, pending);
        backend.set(api.conversations.webGet, pending);

        backend.set(api.orgTemplates.instanceForRole, pending);
        backend.set(api.org.sessionsUnder, pending);
        backend.set(api.projects.webList, pending);
        backend.set(api.plans.webList, pending);
        backend.set(api.tasks.webList, pending);
        backend.set(api.tasks.webActiveSessions, pending);
        backend.set(api.devices.listDevices, pending);
        backend.set(api.tasks.webListPaginated, {
          page: [],
          continueCursor: "",
          isDone: true,
        });
        backend.set(api.docs.webList, pending);
        backend.set(api.docs.webListPaginated, {
          page: [],
          isDone: true,
          continueCursor: "",
        });
      },
    });
  };
  const renderNode = (node: React.ReactNode) => web.rerender(node);
  const lastNavigation = () => web.navigationLog.at(-1);
  const location = () => lastNavigation()?.path;
  const writes = () =>
    web.backend.mutations.flatMap(({ name, args }) => {
      if (name !== "dispatch:dispatch") return [];
      const { action, args: params } = args as DispatchCallArgs;
      switch (action) {
        case "updateOrgRole":
          return ["update:" + params[0] + ":" + JSON.stringify(params[1])];
        case "provisionOrgRole":
          return ["mutation:" + JSON.stringify({ role_id: params[0] })];
        case "retireOrgRole":
          return ["retire:" + params[0] + ":" + (params[1] ?? "")];
        default:
          return [];
      }
    });
  const toast = () =>
    act(async () =>
      waitForDom(
        web.container,
        () => !!web.container.querySelector("[data-sonner-toast]"),
      ),
    );
  return {
    env,
    state,
    collections,
    mountNode,
    renderNode,
    location,
    lastNavigation,
    writes,
    toast,
    openCalls,
  };
}

const realLayout = { ...(await import("../../ConversationDiffLayout")) };
mock.module("../../ConversationDiffLayout", () => ({
  ...realLayout,
  ConversationDiffLayout: ConversationLayoutStandIn,
}));
afterAll(() => mock.module("../../ConversationDiffLayout", () => realLayout));

async function rolePage() {
  const {
    env,
    state,
    collections,
    mountNode,
    renderNode,
    location,
    lastNavigation,
    writes,
    toast,
    openCalls,
  } = world();
  const { ScopePageInner } = await import("./ScopePage");
  const q = <T extends Element = HTMLElement>(sel: string) =>
    document.querySelector<T>(sel);
  const qa = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
  const text = () => document.body.textContent ?? "";
  const click = async (el: Element | null) => {
    assert.ok(el, "missing element");
    await act(async () => {
      (el as HTMLElement).click();
    });
  };
  const mount = (id: string) =>
    mountNode(
      <ScopePageInner id={id} />,
      "/org/" + id + (env.qs ? "?" + env.qs : ""),
    );

  // The fixture's growth role gets a standing session on the role itself
  // (org.tree stamps it from the conversation carrying standing_role_id).
  const growth = ORG_FIXTURE.roles[0];
  const withStanding: OrgTree = {
    ...ORG_FIXTURE,
    roles: [{ ...growth, counts: { ...growth.counts, needs_input: 2 } }],
  };
  env.tree = withStanding;
  // Three hands under the role wait on a person; they wait on the ROLE, and
  // none of them reaches the first screen or the header.
  const roleHand = (id: string) => ({
    _id: id,
    org_role_id: growth._id,
    state: "needs_input",
  });
  const roleRows = () => ({
    "fixture-growth-conv": {
      _id: "fixture-growth-conv",
      standing_role_id: growth._id,
    },
    [growth.sessions[0]._id]: roleHand(growth.sessions[0]._id),
    [growth.sessions[1]._id]: roleHand(growth.sessions[1]._id),
    [growth.sessions[2]._id]: roleHand(growth.sessions[2]._id),
  });
  state.sessions = roleRows();

  return {
    env,
    state,
    collections,
    mountNode,
    renderNode,
    location,
    lastNavigation,
    writes,
    toast,
    openCalls,
    mount,
    q,
    qa,
    text,
    click,
    growth,
    withStanding,
  };
}

test("the desktop role page opens on its conversation and shows Overview on demand", async () => {
  const {
    state,
    location,
    lastNavigation,
    writes,
    mount,
    q,
    qa,
    click,
    growth,
  } = await rolePage();
  await mount("or-1");
  assert.equal(
    q("[data-scope-layout]")!.getAttribute("data-scope-layout"),
    "side",
  );
  assert.equal(
    q("[data-layout]")!.getAttribute("data-layout"),
    "fixture-growth-conv",
    "the role's standing conversation is mounted inline",
  );
  assert.equal(
    q("[data-layout]")!.getAttribute("data-owner"),
    "1",
    "the host talks to the seat: the composer sends",
  );
  assert.equal(
    q("[data-layout]")!.getAttribute("data-fold-working"),
    "1",
    "machine prompts fold away (F4.1)",
  );
  assert.equal(
    q("[data-layout]")!.getAttribute("data-density"),
    "condensed",
    "tools fold to receipts",
  );
  expectAbsent(
    q("[data-scope-lead]"),
    "the role's head says what it carries, so its thread opens on the thread itself",
  );
  expectAbsent(
    q("[data-scope-stripe]"),
    "a seated role's state line is pinned above its composer, so the header leaves it out",
  );
  expectAbsent(
    q("[data-scope-lead-ask]"),
    "the lead never counts sessions waiting on a person: those wait on the role, which raises what it cannot answer in its own thread",
  );
  for (const word of ["trust", "model", "today", "wakes", "tokens", "host"])
    assert.ok(
      !qa("header *").some(
        (el) =>
          el.children.length === 0 &&
          el.textContent?.trim().toLowerCase() === word,
      ),
      `the header no longer says ${word}`,
    );
  assert.equal(
    q("[data-layout]")!.getAttribute("data-focus-input"),
    "1",
    "the composer comes to hand on a desktop",
  );
  assert.ok(q("[data-composer]"), "the composer is Talk");
  assert.equal(
    qa("button").filter((b) =>
      /^(Talk|Wake)$/.test(b.textContent?.trim() ?? ""),
    ).length,
    0,
    "Talk and Wake left the header",
  );
  // Under the name, the head its sheet and its hover card say: whom it
  // reports to (their sheet one click away), its state, what it carries, since when.
  const headFacts = q("[data-scope-head-facts]")!;
  assert.ok(
    headFacts?.closest("[data-scope-head]"),
    "the role's head sits on its header row",
  );
  const reportsTo = headFacts.querySelector("[data-scope-reports-to] a")!;
  assert.match(
    reportsTo.getAttribute("href")!,
    /^\/org\//,
    "whom it reports to opens their sheet on the Org screen",
  );
  assert.ok(
    headFacts.querySelector("[data-role-state]"),
    "its state, in the word its line uses",
  );
  assert.doesNotMatch(
    headFacts.textContent!,
    /Owns organic search/,
    "with nothing led or owned, the charter stays in the brief, not on the header row",
  );
  expectAbsent(
    q("[data-scope-state]"),
    "one state on the head, not a chip beside it",
  );
  expectAbsent(
    q("[data-scope-aside]"),
    "the page opens on the conversation, the panel collapsed",
  );
  await click(headFacts);
  assert.equal(
    q("[data-scope-aside]")!.getAttribute("data-scope-aside"),
    "side",
    "a click on the head opens the panel",
  );
  assert.ok(
    q("[data-scope-head-facts]"),
    "the head stays while the panel is open",
  );
  // A role's page opens on Overview (org-roles-run-work.md R3): what it is
  // for, the briefing, its notes behind a fold, then what happened lately.
  assert.equal(
    q("[data-scope-tab-active]")!.getAttribute("data-scope-tab-active"),
    "scope",
    "a role's page opens on Overview",
  );
  assert.deepEqual(
    qa("[data-scope-tab]").map((el) => el.textContent),
    ["Overview", "Work", "Sessions", "Decisions", "Triggers", "Settings"],
    "a role has six tabs, in this order",
  );
  assert.ok(
    q("[data-scope-briefing]"),
    "the Overview carries the briefing (F5.1)",
  );
  assert.deepEqual(
    qa("[data-scope-briefing] [data-scope-section]").map((el) =>
      el.getAttribute("data-scope-section"),
    ),
    ["doing"],
    "the sections with something to say, in order; this role has written no line yet, and sessions waiting on the role are not a section",
  );
  assert.deepEqual(
    qa("[data-role-overview] > [data-scope-section]").map((el) =>
      el.getAttribute("data-scope-section"),
    ),
    ["charter", "notes", "lately"],
    "what it is for above the briefing; its notes and the activity under it",
  );
  assert.match(
    q("[data-role-charter]")!.textContent!,
    /Owns organic search, paid search and the weekly growth review\./,
    "the charter reads on the first screen",
  );
  assert.equal(
    q('[data-scope-section="notes"]')!.hasAttribute("open"),
    false,
    "its notes stay folded until asked for",
  );
  assert.ok(
    q('[data-scope-section="lately"]'),
    "the activity is the Overview's last block, not a tab",
  );
  expectAbsent(
    q('[data-role-scope="page"]'),
    "the project cards, the session groups and the counts left the first screen",
  );
  assert.equal(
    qa("[data-scope-tab-count]").length,
    0,
    "and the tab strip carries no number",
  );
  expectAbsent(
    q("[data-scope-panel-dot]"),
    "the toggle carries no dot: what the role needs from the person is in its own thread",
  );
  // Close and reopen from the header.
  await click(q("[data-scope-panel-toggle]"));
  expectAbsent(q("[data-scope-aside]"), "closed");
  assert.equal(
    q("[data-scope-panel-toggle]")!.getAttribute("data-scope-panel-toggle"),
    "closed",
  );
  assert.ok(q("[data-layout]"), "the conversation stays");
  await click(q("[data-scope-panel-toggle]"));
  assert.equal(
    q("[data-scope-aside]")!.getAttribute("data-scope-aside"),
    "side",
  );
  // The panel's own close.
  await click(q("[data-scope-panel-close]"));
  expectAbsent(q("[data-scope-aside]"));
  // A tab click writes the URL, so the tab stays linkable.
  await click(q("[data-scope-panel-toggle]"));
  await click(q('[data-scope-tab="sessions"]'));
  assert.deepEqual(lastNavigation(), {
    path: "/org/or-1?tab=sessions",
    action: "replace",
  });
  await click(q('[data-scope-tab="work"]'));
  assert.equal(location(), "/org/or-1?tab=work");
  // The tab the page opens on is its bare URL.
  await click(q('[data-scope-tab="scope"]'));
  assert.equal(location(), "/org/or-1");
});

test("a narrow role page overlays the panel on its conversation", async () => {
  const { env, mount, q, click } = await rolePage();
  env.wide = false;
  await mount("or-1");
  assert.equal(
    q("[data-scope-layout]")!.getAttribute("data-scope-layout"),
    "overlay",
  );
  expectAbsent(
    q("[data-scope-aside]"),
    "a narrow page opens on the conversation, not covered by the board",
  );
  await click(q("[data-scope-panel-toggle]"));
  assert.equal(
    q("[data-scope-aside]")!.getAttribute("data-scope-aside"),
    "overlay",
  );
  assert.ok(q("[data-layout]"), "the conversation is still there under it");
  await click(q("[data-scope-panel-close]"));
  expectAbsent(q("[data-scope-aside]"));
});

test("a phone can open the role panel as a sheet or by a tab link", async () => {
  const { env, mount, q, click } = await rolePage();
  env.phone = true;
  await mount("or-1");
  assert.equal(
    q("[data-scope-layout]")!.getAttribute("data-scope-layout"),
    "sheet",
  );
  expectAbsent(q("[data-scope-aside]"), "the conversation leads on the phone");
  assert.equal(
    q("[data-layout]")!.getAttribute("data-focus-input"),
    "0",
    "no keyboard pop on the phone",
  );
  await click(q("[data-scope-panel-toggle]"));
  assert.equal(
    q("[data-scope-aside]")!.getAttribute("data-scope-aside"),
    "sheet",
  );
  assert.equal(
    q("[data-scope-panel-close]")!.getAttribute("aria-label"),
    "Back to the conversation",
  );
  await click(q("[data-scope-panel-close]"));
  expectAbsent(q("[data-scope-aside]"), "handed back to the conversation");
  // A link straight to a tab opens the sheet on it.
  env.qs = "tab=sessions";
  await mount("or-1");
  assert.equal(
    q("[data-scope-aside]")!.getAttribute("data-scope-aside"),
    "sheet",
  );
  assert.equal(
    q("[data-scope-tab-active]")!.getAttribute("data-scope-tab-active"),
    "sessions",
  );
});

test("old role and workspace tab links still open their current views", async () => {
  const { env, collections, mount, q, qa, click } = await rolePage();
  env.phone = false;
  env.wide = true;
  collections.tasks = [
    fixtures.task.build({
      title: "Review the growth plan",
      status: "open",
      project_id: "fixture-project-growth",
      promoted: true,
    }),
  ];
  env.qs = "tab=line";
  await mount("or-1");
  assert.equal(
    q("[data-scope-tab-active]")!.getAttribute("data-scope-tab-active"),
    "work",
  );
  assert.equal(
    q('[data-work-view="status"]')?.getAttribute("aria-selected"),
    "true",
  );
  assert.deepEqual(
    qa("[data-work-view]").map((el) => el.textContent),
    ["Tasks", "By status", "Plans", "Pages"],
  );
  await click(q('[data-work-view="tasks"]'));
  assert.match(document.body.textContent!, /Review the growth plan/);
  env.qs = "tab=charter";
  await mount("or-1");
  assert.equal(
    q("[data-scope-tab-active]")!.getAttribute("data-scope-tab-active"),
    "scope",
  );
  // A role only tab is refused for the root and falls back to its activity.
  env.qs = "tab=brief";
  await mount("workspace");
  assert.equal(
    q("[data-scope-tab-active]")!.getAttribute("data-scope-tab-active"),
    "feed",
  );
  assert.deepEqual(
    qa("[data-scope-tab]").map((el) => el.textContent),
    ["Activity", "Work", "Sessions", "Decisions"],
    "the workspace has four tabs",
  );
  env.qs = "";
});

test("the workspace shows its agent or offers to hire one", async () => {
  const { env, mount, q, withStanding } = await rolePage();
  await mount("workspace");
  assert.equal(
    q("[data-layout]")!.getAttribute("data-layout"),
    "fixture-anchor-conv",
  );
  env.tree = { ...withStanding, anchors: [] };
  await mount("workspace");
  expectAbsent(q("[data-layout]"));
  assert.equal(q("[data-hire-head]")?.textContent, "Hire Head of People");
  assert.ok(q("h1.text-base"));

  env.tree = withStanding;
});

test("a member can read the role conversation with ownership disabled", async () => {
  const { env, state, mount, q, withStanding } = await rolePage();
  env.tree = {
    ...withStanding,
    people: withStanding.people.map((p) => ({
      ...p,
      is_me: false,
      role: "member" as const,
    })),
  };
  state.currentUser = { _id: "fixture-user-sam" };
  await mount("or-1");
  assert.equal(
    q("[data-layout]")!.getAttribute("data-owner"),
    "0",
    "a member who is neither host nor parent asks to send",
  );
  state.currentUser = { _id: "fixture-user-me" };
  env.tree = withStanding;
});

test("an unstarted role offers to start for its host and names the host for members", async () => {
  const { env, state, writes, mount, q, text, click, growth, withStanding } =
    await rolePage();
  const unseated: OrgTree = {
    ...withStanding,
    roles: [
      {
        ...growth,
        standing: null,
        anchor_id: undefined,
        counts: { ...growth.counts, needs_input: 0 },
      },
    ],
  };
  env.tree = unseated;
  await mount("or-1");
  expectAbsent(q("[data-layout]"), "no composer that goes nowhere");
  expectAbsent(q("[data-composer]"));
  assert.ok(q("[data-scope-unseated]"));
  assert.match(text(), /Head of Growth has not started yet/);
  assert.match(
    text(),
    /Owns organic search, paid search and the weekly growth review\./,
    "the charter says what the area is",
  );
  assert.match(text(), /It looks after Growth, SEO and AI citations\./);
  assert.match(text(), /reports to Ashot Petrosian/);
  expectAbsent(q("[data-scope-state]"), "no state chip before it starts");
  assert.match(q("[data-scope-stripe]")!.textContent!, /Not started yet/);
  await click(q("[data-scope-provision]"));
  assert.ok(
    writes().some((c) => c === `mutation:{"role_id":"${growth._id}"}`),
    "the one gesture starts the role",
  );
  expectAbsent(q("[data-scope-aside]"), "the panel stays collapsed");
  // A person who cannot reshape the role is told who can.
  env.tree = {
    ...unseated,
    people: unseated.people.map((p) => ({
      ...p,
      is_me: false,
      role: "member" as const,
    })),
  };
  state.currentUser = { _id: "fixture-user-sam" };
  await mount("or-1");
  expectAbsent(q("[data-scope-provision]"));
  assert.match(
    q("[data-scope-ask-host]")!.textContent!,
    /Ask Ashot Petrosian to start it/,
  );
  state.currentUser = { _id: "fixture-user-me" };
  env.tree = withStanding;
});

test("the paused role says what still works and offers Resume", async () => {
  const { env, writes, mount, q, qa, click, growth, withStanding } =
    await rolePage();
  env.tree = {
    ...withStanding,
    roles: [{ ...withStanding.roles[0], status: "paused" }],
  };
  await mount("or-1");
  assert.match(
    q("[data-head-paused]")!.textContent!,
    /Head of Growth is paused: its triggers hold until you resume it\. Messages still reach it\./,
  );
  await click(qa("[data-head-paused] button")[0]);
  assert.equal(writes().at(-1), `update:${growth._id}:{"status":"active"}`);
  env.tree = withStanding;
});

test("the role menu pauses immediately and retires only after confirmation", async () => {
  const { lastNavigation, writes, toast, mount, q, qa, click, growth } =
    await rolePage();
  await mount("or-1");
  const openMenu = () =>
    act(async () => {
      q("[data-scope-actions]")!.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
  await openMenu();
  assert.deepEqual(
    qa("[data-scope-action]").map((el) => el.textContent),
    ["Pin to header", "Pause role", "Retire role…"],
    "the same words wherever a role is paused or retired",
  );
  await click(q('[data-scope-action="pause"]'));
  assert.equal(writes().at(-1), `update:${growth._id}:{"status":"paused"}`);
  await openMenu();
  await click(q('[data-scope-action="retire"]'));
  assert.match(
    q("[data-retire-dialog]")!.textContent!,
    /Retire Head of Growth\?/,
  );
  assert.match(
    q("[data-retire-dialog]")!.textContent!,
    /Roles under it report to Ashot Petrosian\. Its triggers are cancelled and its thread is kept\./,
    "what retiring does is said once, where it is confirmed",
  );
  assert.ok(
    !writes().some((c) => c.startsWith("retire:")),
    "nothing is retired before the confirm",
  );
  await click(q("[data-retire-submit]"));
  assert.equal(writes().at(-1), "retire:" + growth._id + ":");
  assert.deepEqual(lastNavigation(), { path: "/org", action: "push" });
  await toast();
  assert.match(
    q("[data-sonner-toast]")!.textContent!,
    /Retired Head of Growth/,
  );
});

test("the sessions tab groups hands and reads the latest task pointer", async () => {
  const { state, collections, mountNode, renderNode, openCalls, q, qa, click } =
    await rolePage();
  const { HandGroups } = await import("./ScopeTabs");
  const hand = (
    i: number,
    state: OrgSession["state"],
    age: number,
    title: string,
  ): OrgSession => ({
    _id: `h${i}`,
    short_id: `jx7h${i}`,
    title,
    agent_type: "claude",
    state,
    updated_at: T0 - age,
    subagent_count: 0,
    is_anchor: false,
  });
  const rows = [
    hand(1, "working", 60_000, "Draft the release notes"),
    hand(2, "needs_input", 30 * 60_000, "Pick a CTA variant"),
    hand(3, "done", 3 * 3_600_000, "Fix the cold start"),
    hand(4, "dormant", 5 * 60_000, "Watch CI on main"),
    hand(5, "idle", 9 * 60_000, "Blank"),
    hand(6, "needs_input", 2 * 60_000, "Approve the schema"),
  ];
  state.sessions = {
    h1: {
      _id: "h1",
      thread_state: "Writing the 1.2 notes\nNext: screenshots",
      active_task_id: "t-notes",
    },
    h2: { _id: "h2", thread_state: "Blocked: pick A, B or C" },
  };
  collections.tasks = [
    {
      _id: "t-notes",
      short_id: "ct-10",
      title: "Release notes 1.2",
      status: "in_progress",
    },
    {
      _id: "t-notes-1",
      short_id: "ct-11",
      title: "Write",
      status: "done",
      parent_id: "t-notes",
    },
    {
      _id: "t-notes-2",
      short_id: "ct-12",
      title: "Screens",
      status: "open",
      parent_id: "t-notes",
    },
    {
      _id: "t-notes-3",
      short_id: "ct-13",
      title: "Dropped",
      status: "dropped",
      parent_id: "t-notes",
    },
    {
      _id: "t-cold",
      short_id: "ct-20",
      title: "Cold start",
      status: "done",
      conversation_ids: ["h3"],
    },
  ];
  const facts: BriefHand[] = [
    {
      _id: "h4" as Id<"conversations">,
      waiting_since: null,
      short_id: "jx7h4",
      title: "Watch CI on main",
      state: "dormant",
      state_line: "Waiting on run 8841",
      state_status: "dormant",
      state_at: T0,
      updated_at: T0,
      task: null,
    },
  ];
  await mountNode(
    React.createElement(HandGroups, {
      rows,
      hands: facts,
      now: T0,
      onOpen: (s: OrgSession) => openCalls.push(`open:${s._id}`),
    }),
  );
  assert.deepEqual(
    qa("[data-hand-group]").map((g) => g.getAttribute("data-hand-group")),
    ["needs_input", "done", "working", "dormant", "idle"],
    "the inbox's order",
  );
  assert.deepEqual(
    qa("[data-hand-group] h3").map((h) => h.textContent),
    ["Needs you2", "Done1", "Working1", "Dormant1", "Idle1"],
    "each header carries its count",
  );
  assert.deepEqual(
    qa('[data-hand-group="needs_input"] [data-hand]').map((r) =>
      r.getAttribute("data-hand"),
    ),
    ["h2", "h6"],
    "a queue you clear reads oldest first",
  );
  const line = (id: string) =>
    q(`[data-hand="${id}"] [data-hand-line]`)!.textContent;
  assert.equal(
    line("h1"),
    "Writing the 1.2 notes",
    "the store's state line, first line only",
  );
  assert.equal(line("h2"), "Blocked: pick A, B or C");
  assert.equal(
    line("h4"),
    "Waiting on run 8841",
    "the brief's facts stand in when the store has no row",
  );
  assert.equal(line("h5"), "idle", "no line pinned: the state word");
  assert.equal(
    q('[data-hand="h1"] [data-hand-task]')!.getAttribute("data-hand-task"),
    "ct-10",
    "the session's own task pointer",
  );
  assert.equal(
    q('[data-hand="h1"] [data-hand-progress]')!.getAttribute(
      "data-hand-progress",
    ),
    "1/2",
    "subtasks counted live; the dropped one for neither",
  );
  assert.equal(
    q('[data-hand="h3"] [data-hand-task]')!.getAttribute("data-hand-task"),
    "ct-20",
    "a task listing the session binds it too",
  );
  expectAbsent(
    q('[data-hand="h3"] [data-hand-progress]'),
    "no subtasks, no counter",
  );
  assert.match(q('[data-hand="h2"]')!.textContent!, /30m/, "the age");
  await click(q('[data-hand="h6"]'));
  assert.equal(openCalls.pop(), "open:h6");
  // The store's task pointer changes: the row follows in the same tick.
  await act(async () =>
    useInboxStore
      .getState()
      .syncRecord("sessions", "h1", { active_task_id: "t-cold" }),
  );
  await act(async () =>
    renderNode(
      React.createElement(HandGroups, {
        rows: [...rows],
        hands: facts,
        now: T0,
        onOpen: () => {},
      }),
    ),
  );
  assert.equal(
    q('[data-hand="h1"] [data-hand-task]')!.getAttribute("data-hand-task"),
    "ct-20",
  );
});

// F5.4: the first screen holds exactly what the person reads, and nothing
// the board holds. The Calling lead's shape: two projects, six plans, 83
// tasks, 33 hands waiting on a person.
async function verifyFirstScreen() {
  const { env, state, collections, mountNode, renderNode } = world();
  const DAY = 86_400_000;
  const growth = ORG_FIXTURE.roles[0];
  const ROLE = "fixture-role-calling";
  const STANDING = "fixture-calling-conv";
  // 33 hands waiting on a person, 4 at work.
  const hands = Array.from({ length: 37 }, (_, i): OrgSession => ({
    _id: `calling-h${i}`,
    short_id: `jx7c${String(i).padStart(3, "0")}`,
    title: `Hand ${i}`,
    agent_type: "claude",
    state: i < 33 ? "needs_input" : "working",
    updated_at: T0 - (i + 1) * 60_000,
    subagent_count: 0,
    is_anchor: false,
    org_role_id: ROLE,
  }));
  const calling: OrgRole = {
    ...growth,
    _id: ROLE,
    short_id: "or-7",
    name: "Calling lead",
    handle: "calling",
    scope: { project_ids: ["p-union", "p-market"], plan_ids: [] },
    scope_names: {
      projects: [
        { id: "p-union", title: "Union goals", short_id: "pj-union" },
        { id: "p-market", title: "Market growth", short_id: "pj-market" },
      ],
      plans: [],
    },
    counts: { needs_input: 33, working: 4, done: 0, dormant: 0, idle: 0 },
    sessions: [...hands.slice(33), ...hands.slice(0, 4)],
    total: hands.length,
    standing: {
      conversation_id: STANDING,
      short_id: "jx7call",
      state: "working",
      state_line: "Filling the third market",
      state_status: "working",
      state_at: T0 - 600_000,
    },
  };
  const projects = [
    {
      _id: "p-union",
      title: "Union goals",
      short_id: "pj-union",
      status: "active",
    },
    {
      _id: "p-market",
      title: "Market growth",
      short_id: "pj-market",
      status: "active",
    },
  ];
  const plans = Array.from({ length: 6 }, (_, i) => ({
    _id: `pl${i}`,
    short_id: `pl-${i}`,
    title: `Plan ${i}`,
    status: "active",
    project_id: i < 3 ? "p-union" : "p-market",
  }));
  const tasks = Array.from({ length: 83 }, (_, i) => ({
    _id: `t${i}`,
    short_id: `ct-${i}`,
    title: `Task ${i}`,
    status: i % 3 ? "open" : "done",
    project_id: i % 2 ? "p-union" : "p-market",
  }));
  env.tree = { ...ORG_FIXTURE, roles: [calling] };
  env.summary = {
    scope: { project_ids: ["p-union", "p-market"], plan_ids: [] },
    projects: projects.map(({ _id: id, ...row }) => ({ id, ...row })),
    plans: plans.map(({ _id: id, ...row }) => ({
      id,
      ...row,
      updated_at: T0,
      progress: { total: 14, done: 6, in_progress: 2, open: 6 },
    })),
    tasks: {
      total: 83,
      open: 55,
      by_status: { open: 55, done: 28 },
      by_priority: {},
    },
    sessions: {
      needs_input: 33,
      working: 4,
      done: 0,
      dormant: 0,
      idle: 0,
      total: 37,
    },
    decisions: { open: 5 },
    overlaps: [],
    generated_at: T0,
  };
  state.sessions = {
    [STANDING]: { _id: STANDING, standing_role_id: ROLE },
    ...Object.fromEntries(
      hands.map((h) => [
        h._id,
        { _id: h._id, org_role_id: ROLE, state: h.state },
      ]),
    ),
  };
  collections.projects = projects;
  collections.plans = plans;
  collections.tasks = tasks;

  const { ScopeOverviewTab } = await import("./ScopePanel");
  const q = (sel: string) => document.querySelector<HTMLElement>(sel);
  const qa = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
  function Screen({ brief }: { brief: string | null }) {
    return React.createElement(ScopeOverviewTab, {
      role: calling,
      now: T0,
      narrative: brief,
    });
  }
  let ready = false;
  const render = async (brief: string | null) => {
    if (ready) {
      await renderNode(<Screen brief={brief} />);
    } else {
      await mountNode(<Screen brief={brief} />);
      ready = true;
    }
  };

  const today = new Date(T0).toISOString().slice(0, 10);
  const old = new Date(T0 - 12 * DAY).toISOString().slice(0, 10);
  await render(
    `Calling: two markets filled\n\n## Where it stands\n- Union goals: the page is written and waits on your read; nothing else moves until it ships. (${today})\n- pj-market: two markets are filled and the third waits on a lawyer. (${old})\n\n## Goals: Ashot\n1. A goal`,
  );

  // Exactly: two project sentences, one activity line. The 33 hands waiting
  // on a person wait on the role and are nowhere on the first screen.
  expectAbsent(
    q('[data-scope-section="needs-you"]'),
    "no needs-you block: the role raises what it cannot answer in its own thread",
  );
  const stands = qa("[data-scope-briefing] [data-scope-stands]");
  assert.equal(stands.length, 2, "two project sentences");
  const union = q('[data-scope-stands="pj-union"]')!,
    market = q('[data-scope-stands="pj-market"]')!;
  assert.match(
    union.textContent!,
    /Union goals.*the page is written and waits on your read/,
  );
  assert.equal(
    union.querySelector("[data-scope-stands-age]")!.textContent,
    "today",
    "every line says how old it is, quietly",
  );
  assert.match(
    market.textContent!,
    /Market growth.*two markets are filled and the third waits on a lawyer/,
    "matched by the short id the role wrote",
  );
  assert.equal(
    market
      .querySelector("[data-scope-stands-age]")!
      .getAttribute("data-scope-stands-age"),
    "12",
    "a line older than a week says how old it is",
  );
  const doing = q("[data-scope-briefing] [data-scope-doing]")!;
  assert.match(
    doing.textContent!,
    /^Filling the third market/,
    "one activity line, in the role's own words as its sheet says them",
  );
  assert.ok(
    doing.querySelector('a[href*="calling-h33"]'),
    "and the session it is on now, as a pill",
  );
  // No digit outside those lines: no count of hands waiting, no task count,
  // no plan fraction, no progress bar.
  const briefing = q("[data-scope-briefing]")!.cloneNode(true) as HTMLElement;
  for (const el of [
    ...briefing.querySelectorAll(
      "[data-scope-stands-line], [data-scope-doing]",
    ),
  ])
    el.remove();
  assert.doesNotMatch(
    briefing.textContent!,
    /\d/,
    `no digit outside the lines: ${briefing.textContent}`,
  );
  for (const word of ["waiting on a person", "plan", "task", "open", "done"])
    assert.ok(
      !briefing.textContent!.toLowerCase().includes(word),
      `the first screen never says ${JSON.stringify(word)}`,
    );

  // A role with no brief lines.
  await render(null);
  // Nothing to say is said by saying nothing: no empty sections, no placeholder lines.
  expectAbsent(q('[data-scope-section="stands"]'));
  assert.equal(qa("[data-scope-briefing] [data-scope-stands-line]").length, 0);

  // The playbook and the wake (org-staffing.md S38) sit under the briefing,
  // never in it: the briefing keeps its two sentences and one activity line.
  const { RolePlaybookSections } = await import("./ScopePanel");
  const playbook = `Calling: steady\n\n## North metric\nIntroductions a day.\n- ${old}: 4.4/day (milestone: first week above 4)\n- ${today}: 3.7/day\n\n## Rules learned\n- Read the threads before the counters. Learned from: a diagnosis made from totals was wrong. (${old})\n\n## Standing decisions\n- Never deploy past a red gate. (Ashot, ${old})`;
  const routine = {
    interval_ms: 12 * 3_600_000,
    wake: {
      every_ms: 12 * 3_600_000,
      precheck: null,
      focus: "the launch queue",
      why: "results land twice a day",
      tuned_at: T0 - DAY,
    },
  };
  await act(async () =>
    renderNode(
      React.createElement(
        "div",
        null,
        React.createElement(Screen, { brief: playbook }),
        React.createElement(RolePlaybookSections, {
          narrative: playbook,
          routine,
          now: T0,
        }),
      ),
    ),
  );
  expectAbsent(
    q("[data-scope-briefing] [data-role-playbook]"),
    "the playbook is not part of the briefing",
  );
  assert.deepEqual(
    qa("[data-role-playbook] [data-playbook]").map((el) =>
      el.getAttribute("data-playbook"),
    ),
    ["metric", "rules", "decisions"],
    "the sections the role wrote, in order",
  );
  assert.match(
    q('[data-playbook="rules"]')!.textContent!,
    /Learned from: a diagnosis made from totals was wrong/,
  );
  assert.match(
    q("[data-role-wake]")!.textContent!,
    /every 12 hours · focus: the launch queue/,
  );
  assert.match(
    q("[data-role-wake-why]")!.textContent!,
    /It set this itself on .*: results land twice a day/,
  );
  // A brief with no playbook and a role with no check draw neither block.
  await act(async () =>
    renderNode(
      React.createElement(RolePlaybookSections, {
        narrative: "Calling: steady",
        routine: null,
        now: T0,
      }),
    ),
  );
  expectAbsent(q('[data-scope-section="playbook"]'));
  expectAbsent(q('[data-scope-section="wake"]'));
}

test(
  "F5.4: the first screen holds two project sentences and one activity line, and no digit outside them",
  verifyFirstScreen,
  120_000,
);

// ct-87448: a role's header is one row at every width, as a session's is.
// On a phone the role's facts dropped to a second bordered row under the
// header, so the page spent two rows of chrome before the conversation
// where a session spends one. Whatever the facts become on a phone, they
// live on the header row or not at all, and nothing sits between the
// header and the conversation.
async function verifyPhoneHeaderOneRow() {
  const { env, state, mountNode } = world();
  const { ScopePageInner } = await import("./ScopePage");
  const growth = ORG_FIXTURE.roles[0];
  env.tree = ORG_FIXTURE as OrgTree;
  env.qs = "";
  state.sessions = {
    "fixture-growth-conv": {
      _id: "fixture-growth-conv",
      standing_role_id: growth._id,
    },
  };
  env.phone = true;
  env.wide = false;
  await mountNode(<ScopePageInner id="or-1" />);
  const head = document.querySelector("[data-scope-head]")!;
  assert.ok(head, "the role page has its header");
  for (const facts of document.querySelectorAll("[data-scope-head-facts]")) {
    assert.ok(
      facts.closest("[data-scope-head]"),
      "on a phone the role's facts sit on the header row, not on a second row under it",
    );
  }
  const body = document.querySelector("[data-scope-conversation]")!;
  const rows: string[] = [];
  for (
    let el = head.nextElementSibling;
    el && !el.contains(body);
    el = el.nextElementSibling
  ) {
    if ((el.textContent ?? "").trim() || el.children.length)
      rows.push(el.outerHTML.slice(0, 120));
  }
  assert.deepEqual(
    rows,
    [],
    "no chrome row sits between the role's header and its conversation on a phone",
  );
}

test(
  "ct-87448: on a phone a role's header is one row, its facts on it or gone",
  verifyPhoneHeaderOneRow,
  120_000,
);
