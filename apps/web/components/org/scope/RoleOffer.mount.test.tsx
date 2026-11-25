import type { Doc } from "@codecast/convex/convex/_generated/dataModel";
import { api } from "@codecast/convex/convex/_generated/api";
import { COMPANY_REVIEW_TITLE } from "@codecast/org/orgReview";
import { afterEach, spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { act } from "react";
import { testFaker } from "@codecast/test-helpers/faker";
import { expectAbsent, expectPresent } from "../../../test-helpers/domExpect";
import { mountWeb } from "../../../test-helpers/mountWeb";
import { pending } from "../../../test-helpers/testConvex";
import type { TaskRow } from "../../triggerTasks";
import { ORG_FIXTURE } from "../orgFixture";
import type { OrgProposalListRow } from "../orgStaffingTypes";
import type { OrgRole, OrgTree } from "../orgTypes";
import { fakeRoleOffer, RoleOffer } from "./RoleOffer";

const NOW = Date.UTC(2026, 10, 24, 18);
const SEAT = "conv-head-seat";
const me = ORG_FIXTURE.people.find((p) => p.is_me)!;
const faker = testFaker("RoleOffer.mount.test.tsx");
type ReviewTrigger = TaskRow &
  Pick<Doc<"agent_tasks">, "requested_run_source" | "requested_run_focus">;

let restoreClock: (() => void) | undefined;
afterEach(() => {
  restoreClock?.();
  restoreClock = undefined;
  fakeRoleOffer(null);
});

function world() {
  const clock = spyOn(Date, "now").mockReturnValue(NOW);
  restoreClock = () => clock.mockRestore();
  const head: OrgRole = {
    ...ORG_FIXTURE.roles[0],
    _id: "role-head",
    short_id: "or-90",
    handle: "head-of-people",
    name: "Head of People",
    status: "active",
    reports_to: { kind: "user", user_id: me.user_id },
    host_user_id: me.user_id,
    anchor_id: undefined,
    standing: { conversation_id: SEAT, state: "idle" },
  };
  const env = {
    tree: { ...ORG_FIXTURE, roles: [head, ...ORG_FIXTURE.roles] } as OrgTree,
    tasks: [] as ReviewTrigger[],
    proposals: [] as OrgProposalListRow[],
    meId: me.user_id,
  };
  let web: Awaited<ReturnType<typeof mountWeb>> | undefined;
  const mount = async (conversationId = SEAT) => {
    await web?.close();
    web = await mountWeb(<RoleOffer conversationId={conversationId} />, {
      path: "/inbox",
      dispatch: true,
      setup(backend, store) {
        store.syncTable("currentUser", { _id: env.meId });
        store.syncTable("clientState", {
          ui: { active_team_id: env.tree.workspace.id },
        });
        store.syncTable("orgTree", env.tree);
        store.syncTable("agentTasks", env.tasks);
        store.syncTable("orgProposals", env.proposals);
        backend.set(api.org.tree, pending);
        backend.set(api.org.roles, pending);
        backend.set(api.agentTasks.webList, pending);
        backend.set(api.agentTasks.webGet, pending);
        backend.mutation(api.dispatch.dispatch, null);
      },
    });
    return web;
  };
  const q = (selector: string) => document.querySelector<HTMLElement>(selector);
  const click = (selector: string) =>
    act(async () => {
      const button = q(selector);
      expectPresent(button, selector);
      button.click();
    });
  const review = (over: Partial<ReviewTrigger> = {}): ReviewTrigger => ({
    _id: "task-review",
    short_id: "tr-12",
    title: COMPANY_REVIEW_TITLE,
    prompt: faker.lorem.sentence(),
    status: "scheduled",
    schedule_type: "recurring",
    run_count: 1,
    created_at: NOW - 3 * 86_400_000,
    originating_conversation_id: SEAT,
    run_at: NOW + 5 * 86_400_000,
    last_run_at: NOW - 2 * 86_400_000,
    ...over,
  });
  const proposal = (
    over: Partial<OrgProposalListRow> = {},
  ): OrgProposalListRow => ({
    _id: "p1",
    short_id: "op-4",
    title: "Company review: Acme",
    summary_md: faker.lorem.sentence(),
    author: { kind: "role", id: head._id },
    mode: "review",
    status: "open",
    created_at: NOW - 86_400_000,
    team_id: env.tree.workspace.id,
    counts: { total: 5, decided: 2, applied: 0, failed: 0, skipped: 0 },
    ...over,
  });
  const writes = () =>
    web!.backend.mutations.map(({ name, args }) => {
      assert.equal(name, "dispatch:dispatch");
      assert.ok(
        args &&
          typeof args === "object" &&
          !Array.isArray(args) &&
          !(args instanceof ArrayBuffer),
      );
      return { action: args.action, args: args.args };
    });
  return {
    env,
    writes,
    mount,
    q,
    click,
    review,
    proposal,
    head,
    NOW,
    fakeRoleOffer,
  };
}

test("renders only in the Head of People's own thread, and only with a live Company review", async () => {
  const w = world();
  const foreign = w.review({
    _id: "other-trigger",
    originating_conversation_id: "conv-somebody-else",
  });
  w.env.tasks = [w.review(), foreign];
  w.env.proposals = [];
  await w.mount("conv-somebody-else");
  assert.equal(w.q("[data-role-offer]"), null, "another thread has no offer");
  w.env.tasks = [foreign];
  await w.mount();
  assert.equal(w.q("[data-role-offer]"), null, "no routine, no offer");
  w.env.tasks = [w.review({ status: "cancelled" })];
  await w.mount();
  assert.equal(
    w.q("[data-role-offer]"),
    null,
    "a cancelled routine offers nothing",
  );
});

test("offers to set up, then to review; each press is the trigger's run now, the goal tree with its focus", async () => {
  const w = world();
  w.env.tasks = [w.review()];
  w.env.proposals = [];
  await w.mount();
  assert.equal(
    w.q("[data-role-offer]")!.getAttribute("data-role-offer"),
    "offer",
  );
  assert.equal(
    w.q("[data-offer-action='set-up']")!.textContent,
    "Set up the org",
  );
  assert.equal(w.q("[data-offer-action='review']"), null);
  assert.equal(w.q("[data-offer-open]"), null, "nothing to open yet");
  await w.click("[data-offer-action='set-up']");
  assert.deepEqual(w.writes(), [
    { action: "triggerAction", args: ["task-review", "runNow", null] },
  ]);

  w.env.proposals = [w.proposal({ status: "resolved" })];
  await w.mount();
  assert.equal(
    w.q("[data-offer-action='review']")!.textContent,
    "Review the org now",
  );
  assert.equal(
    w.q("[data-offer-action='goal-tree']")!.textContent,
    "Plan the goal tree",
  );
  await w.click("[data-offer-action='goal-tree']");
  assert.deepEqual(w.writes(), [
    { action: "triggerAction", args: ["task-review", "runNow", "goal_tree"] },
  ]);
});

test("an open proposal is one click away, with what is left to decide", async () => {
  const w = world();
  w.env.tasks = [w.review()];
  w.env.proposals = [
    w.proposal({
      _id: "foreign-proposal",
      short_id: "op-99",
      team_id: "team-elsewhere",
      created_at: w.NOW,
    }),
    w.proposal(),
  ];
  const web = await w.mount();
  const open = w.q("[data-offer-open='op-4']")!;
  assert.equal(open.getAttribute("href"), "/org?proposal=op-4");
  assert.match(open.textContent!, /Open the proposal/);
  expectAbsent(w.q("[data-offer-open='op-99']"));
  assert.match(open.textContent!, /3 to decide/);
  await w.click("[data-offer-open='op-4']");
  assert.deepEqual(web.navigationLog.at(-1), {
    action: "push",
    path: "/org?proposal=op-4",
  });
  // A proposal of another workspace is not this org's.
  w.env.proposals = [
    w.proposal({ team_id: "team-elsewhere", scope_user_id: undefined }),
  ];
  await w.mount();
  assert.equal(w.q("[data-offer-open]"), null);
  assert.ok(
    w.q("[data-offer-action='set-up']"),
    "and does not count as this org's set up",
  );
});

test("a run in flight shows its state and offers no second run", async () => {
  const w = world();
  w.env.proposals = [w.proposal()];
  w.env.tasks = [
    w.review({
      run_at: w.NOW - 5_000,
      requested_run_source: "manual",
      requested_run_focus: "goal_tree",
    }),
  ];
  await w.mount();
  assert.equal(
    w.q("[data-role-offer]")!.getAttribute("data-role-offer"),
    "starting",
  );
  assert.match(
    w.q("[data-offer-run='starting']")!.textContent!,
    /Plan the goal tree: starting/,
  );
  expectPresent(
    w.q("[data-offer-run] a[href='/triggers/task-review']"),
    "the run links to its trigger",
  );
  assert.equal(
    w.q("[data-offer-action]"),
    null,
    "nothing here starts a second run",
  );
  assert.ok(
    w.q("[data-offer-open='op-4']"),
    "the open proposal stays reachable",
  );

  w.env.tasks = [w.review({ last_run_at: w.NOW - 4 * 60_000 })];
  w.env.tree = {
    ...w.env.tree,
    roles: w.env.tree.roles.map((r) =>
      r._id === "role-head"
        ? { ...r, standing: { ...r.standing, state: "working" } }
        : r,
    ),
  };
  await w.mount();
  assert.equal(
    w.q("[data-role-offer]")!.getAttribute("data-role-offer"),
    "reviewing",
  );
  assert.match(
    w.q("[data-offer-run='reviewing']")!.textContent!,
    /Reviewing the org…/,
  );
  assert.match(w.q("[data-offer-run='reviewing']")!.textContent!, /4m/);
  assert.equal(w.q("[data-offer-action]"), null);
  w.env.tree = {
    ...w.env.tree,
    roles: w.env.tree.roles.map((r) => (r._id === "role-head" ? w.head : r)),
  };
});

test("a paused review says so and resumes with the trigger's own verb", async () => {
  const w = world();
  w.env.tasks = [w.review({ status: "paused" })];
  w.env.proposals = [];
  await w.mount();
  assert.equal(
    w.q("[data-role-offer]")!.getAttribute("data-role-offer"),
    "paused",
  );
  assert.equal(w.q("[data-offer-action='set-up']"), null);
  await w.click("[data-offer-action='resume']");
  assert.deepEqual(w.writes(), [
    { action: "triggerAction", args: ["task-review", "resume", null] },
  ]);
});

test("a reader who may not talk to the seat sees the proposal and no run buttons", async () => {
  const w = world();
  const stranger = "user-stranger";
  const tree = w.env.tree;
  w.env.tree = {
    ...tree,
    workspace: { ...tree.workspace, kind: "team" },
    people: tree.people.map((p) => ({
      ...p,
      is_me: false,
      role: "member",
    })),
  };
  w.env.meId = stranger;
  w.env.tasks = [w.review()];
  w.env.proposals = [
    w.proposal({
      team_id: w.env.tree.workspace.id,
      scope_user_id: undefined,
    }),
  ];
  await w.mount();
  assert.ok(w.q("[data-offer-open='op-4']"));
  assert.equal(w.q("[data-offer-action]"), null);
  w.env.tree = tree;
  w.env.meId = String(
    (tree.people.find((p) => p.is_me) ?? tree.people[0]).user_id,
  );
});

test("the fake seam moves the row and dispatches nothing", async () => {
  const w = world();
  w.env.tasks = [w.review()];
  w.env.proposals = [];
  await w.mount();
  await act(async () => {
    w.fakeRoleOffer({ proposals: [w.proposal({ status: "resolved" })] });
  });
  assert.ok(
    w.q("[data-offer-action='review']"),
    "the fake's proposals are what the row reads",
  );
  await w.click("[data-offer-action='goal-tree']");
  assert.deepEqual(w.writes(), [], "a press under a fake starts nothing");
  assert.equal(
    w.q("[data-role-offer]")!.getAttribute("data-role-offer"),
    "starting",
  );
  await act(async () => {
    w.fakeRoleOffer(null);
  });
  assert.ok(
    w.q("[data-offer-action='set-up']"),
    "clearing the fake returns the row to the store",
  );
});
