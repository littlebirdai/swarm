import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { api } from "@codecast/convex/convex/_generated/api";
import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { mountWeb } from "../../test-helpers/mountWeb";
import { standInForOrgGraph } from "../../test-helpers/orgGraphStandIn";
import { pending } from "../../test-helpers/testConvex";
import { waitForDom } from "../../test-helpers/waitForDom";
import { waitForPopupClose } from "../../test-helpers/waitForPopupClose";
import { HireAssistantCard } from "../anchor/AnchorConversation";
import { OrgChart } from "./OrgChart";
import type { OrgReparentRequest } from "./OrgGraph";
import { ORG_FIXTURE, ORG_FIXTURE_ALL_SESSIONS } from "./orgFixture";
import {
  sortOrgSessions,
  type OrgRole,
  type OrgSession,
  type OrgTree,
} from "./orgTypes";

const q = (sel: string, root: ParentNode = document) =>
  root.querySelector<HTMLElement>(sel);
const ME = "fixture-user-me";
const teamId = "o".repeat(32);
const meNode = `person:${ME}`;
const parent = { kind: "user", user_id: ME } as const;
const org: OrgTree = {
  ...ORG_FIXTURE,
  workspace: { kind: "team", id: teamId, name: "Codecast" },
};

let graph: ReturnType<typeof standInForOrgGraph> | undefined;
afterEach(() => {
  graph?.restore();
  graph = undefined;
});
const last = () => graph!.last();
const box = { id: "dragged-node", x: 0, y: 0, w: 1, h: 1 };
const dragRole = (role: OrgRole) =>
  last().canDrag!({
    ...box,
    kind: "role",
    role,
    hidden: 0,
    overflow: 0,
    collapsed: false,
  });
const dragSession = (session: OrgSession) =>
  last().canDrag!({ ...box, kind: "session", session, parent });
const click = (el: HTMLElement) => act(async () => el.click());

async function mount(orgView = "people", tree = org, node = <OrgChart />) {
  graph ??= standInForOrgGraph();
  const result = await mountWeb(node, {
    path: "/org",
    authenticated: true,
    dispatch: true,
    setup(backend, store) {
      store.syncTable("currentUser", { _id: ME });
      store.syncTable("clientState", {
        ui: {
          org_view: orgView,
          org_expand_all: false,
          active_team_id: teamId,
        },
      });
      store.syncTable("orgTree", tree);
      backend.set(api.org.tree, pending);
      backend.set(api.users.getRecentProjectPaths, []);
      backend.set(api.devices.listDevices, pending);
      backend.set(api.docSync.getPresence, []);
      backend.set(api.workflows.webList, []);
      backend.set(api.users.getMySkills, { skills: null });
      backend.set(api.accountSwitch.listAccountProfiles, { devices: [] });
      backend.mutation(api.users.requestTerminalEndpoints, undefined);
      backend.mutation(api.docSync.updatePresence, undefined);
      backend.mutation(api.docSync.removePresence, undefined);
      backend.set(api.anchors.getAnchorSpace, pending);
      backend.set(api.org.roles, pending);
      backend.set(api.projects.webList, pending);
      backend.set(api.orgProposals.get, pending);
      backend.set(api.orgProposals.list, pending);
      backend.action(api.orgHealth.healthReport, null);
      backend.set(api.org.sessionsUnder, ({ parent, cursor, limit }) => {
        const all = sortOrgSessions(
          ORG_FIXTURE_ALL_SESSIONS.filter((s) =>
            parent.kind === "user"
              ? s.owner_user_id === parent.user_id && !s.org_role_id
              : s.org_role_id === parent.role_id,
          ),
        );
        const start = Number(cursor ?? 0);
        const end = start + (limit ?? 8);
        return {
          sessions: all.slice(start, end).map((session) => ({
            ...session,
            _id: session._id as Id<"conversations">,
            owner_user_id:
              (session.owner_user_id as Id<"users"> | undefined) ?? null,
            org_role_id:
              (session.org_role_id as Id<"org_roles"> | undefined) ?? null,
            project_path: session.project_path ?? null,
            git_branch: session.git_branch ?? null,
            character_avatar: session.character_avatar ?? null,
            character_name: session.character_name ?? null,
          })),
          next_cursor: end < all.length ? String(end) : undefined,
        };
      });
      backend.mutation(api.dispatch.dispatch, ({ action }) =>
        action === "reparentOrgSession"
          ? { short_id: "jx1", told: { sessions: 0, roles: 0 } }
          : null,
      );
    },
  });
  const writes = (action: string) =>
    result.backend.mutations.flatMap(({ name, args }) =>
      name === "dispatch:dispatch" &&
      args &&
      typeof args === "object" &&
      !Array.isArray(args) &&
      !(args instanceof ArrayBuffer) &&
      args.action === action
        ? [args.args]
        : [],
    );
  const pages = () =>
    result.backend.queryRequests
      .filter(({ name }) => name === "org:sessionsUnder")
      .map(({ args }) => args);
  return { ...result, el: result.container, done: result.close, writes, pages };
}
test("the switch reads People by default, saves each choice for the person, and an older screen's saved value reads as People", async () => {
  const { el, done, writes } = await mount("map");
  expect(q("[data-org-chart='people']", el)).not.toBeNull();
  expect(q("[data-org-view='people']", el)!.getAttribute("aria-checked")).toBe(
    "true",
  );
  expect(last().lens).toBe("people");
  // People is the interactive chart: session cards under every card, and the page's own gestures.
  expect(last().view.sessionCards).toBe(true);
  expect(dragRole(org.roles[0])).toBe(true);
  await act(async () => {
    q("[data-org-view='everything']", el)!.click();
  });
  expect(writes("updateClientUI").at(-1)).toEqual([{ org_view: "everything" }]);
  // Everything is the people chart with the product layer joined in: same drag, same view.
  expect(last().lens).toBe("people");
  expect(last().product).toEqual({ sessionProject: {} });
  expect(last().view.sessionCards).toBe(true);
  await act(async () => {
    q("[data-org-view='goals']", el)!.click();
  });
  expect(writes("updateClientUI").at(-1)).toEqual([{ org_view: "goals" }]);
  expect(last().lens).toBe("goals");
  // Pressing the view already on writes nothing.
  const n = writes("updateClientUI").length;
  await act(async () => {
    q("[data-org-view='goals']", el)!.click();
  });
  expect(writes("updateClientUI").length).toBe(n);
  await done();
});

test('People: a card folds and unfolds, a "+N more" stack opens what the tree holds then pages the server, and "Show fewer" closes it', async () => {
  const { done, pages } = await mount();
  await act(async () => {
    last().onToggleCollapse(meNode);
  });
  expect(last().view.collapsed.has(meNode)).toBe(true);
  await act(async () => {
    last().onToggleCollapse(meNode);
  });
  expect(last().view.collapsed.has(meNode)).toBe(false);
  // First click: the tree's payload holds eight, the stack drew five; it opens with no request.
  await act(async () => {
    last().onExpandCluster(meNode);
  });
  expect(last().view.expanded[meNode]).toEqual([]);
  expect(pages().length).toBe(0);
  // Second click: the server's next page starts past the eight the tree carried.
  await act(async () => {
    last().onExpandCluster(meNode);
  });
  expect(pages()[0]).toMatchObject({
    parent: { kind: "user", user_id: ME },
    cursor: "8",
    limit: 8,
    team_id: teamId,
  });
  expect(last().view.expanded[meNode].map((row) => row._id)).toEqual([
    "fixture-session-20",
    "fixture-session-1",
    "fixture-session-6",
    "fixture-session-11",
    "fixture-session-16",
    "fixture-session-21",
    "fixture-session-4",
    "fixture-session-9",
  ]);
  expect(last().loadingClusters.has(meNode)).toBe(false);
  // The next click continues from the server's cursor.
  await act(async () => {
    last().onExpandCluster(meNode);
  });
  expect(pages().at(-1)).toMatchObject({ cursor: "16" });
  expect(last().view.expanded[meNode].length).toBe(14);
  await act(async () => {
    last().onCollapseCluster(meNode);
  });
  expect(meNode in last().view.expanded).toBe(false);
  await done();
});

test("People: a dropped session moves at once, and the toast's Undo puts it back where it was; a drop where it already is moves nothing", async () => {
  const { done, writes, store } = await mount();
  const sessionMoves = () => writes("reparentOrgSession");
  const s = ORG_FIXTURE.people[0].sessions[0];
  const to = { kind: "role", role_id: "fixture-role-growth" } as const;
  const req: OrgReparentRequest = {
    subject: { kind: "session", id: s._id, title: s.title },
    target: to,
    targetTitle: "Head of Growth",
    at: { x: 200, y: 200 },
  };
  const reset0 = last().resetKey!;
  await act(async () => {
    last().onReparentRequest(req);
  });
  expect(sessionMoves().length).toBe(1);
  expect(sessionMoves()[0]).toEqual([
    s._id,
    to,
    expect.objectContaining({ row: expect.objectContaining({ _id: s._id }) }),
  ]);
  expect(
    store
      .getState()
      .orgTree?.roles.find((role) => role._id === to.role_id)
      ?.sessions.some((row) => row._id === s._id),
  ).toBe(true);
  expect(last().resetKey).toBe(reset0 + 1);
  expect(q("[data-move-confirm]")).toBeNull();
  // The toast names the new parent and carries an Undo that moves the session back to its person.
  const undo = () =>
    [
      ...document.querySelectorAll<HTMLButtonElement>(
        "[data-sonner-toast] button",
      ),
    ].find((button) => button.textContent === "Undo");
  await act(() => waitForDom(document.body, () => !!undo()));
  expect(undo()!.closest("[data-sonner-toast]")!.textContent).toContain(
    "Head of Growth",
  );
  await click(undo()!);
  expect(sessionMoves().length).toBe(2);
  expect(sessionMoves()[1]).toEqual([
    s._id,
    parent,
    expect.objectContaining({ row: expect.objectContaining({ _id: s._id }) }),
  ]);
  // A drop where it already is moves nothing.
  await act(async () => {
    last().onReparentRequest({ ...req, target: { kind: "user", user_id: ME } });
  });
  expect(sessionMoves().length).toBe(2);
  await done();
});

test("People: a role never moves under its own report, and a member moves only what they own", async () => {
  // A second role under Growth: Growth dropped on it would close a loop.
  const seo: OrgRole = {
    ...ORG_FIXTURE.roles[0],
    _id: "fixture-role-seo",
    short_id: "or-2",
    name: "SEO",
    handle: "seo",
    reports_to: { kind: "role", role_id: "fixture-role-growth" },
    sessions: [],
    total: 0,
  };
  const { done, writes } = await mount("people", {
    ...org,
    roles: [...org.roles, seo],
  });
  const reset0 = last().resetKey!;
  await act(async () => {
    last().onReparentRequest({
      subject: {
        kind: "role",
        id: "fixture-role-growth",
        title: "Head of Growth",
      },
      target: { kind: "role", role_id: "fixture-role-seo" },
      targetTitle: "SEO",
      at: { x: 0, y: 0 },
    });
  });
  expect(last().resetKey).toBe(reset0 + 1);
  expect(writes("reparentOrgRole")).toEqual([]);
  await done();

  // The viewer as a member: their own session moves, a teammate's is not even draggable.
  const tree: OrgTree = {
    ...org,
    people: org.people.map((p) => (p.is_me ? { ...p, role: "member" } : p)),
  };
  const m = await mount("people", tree);
  const mine = ORG_FIXTURE.people[0].sessions[0];
  const sams = ORG_FIXTURE.people[1].sessions[0];
  expect(dragSession(mine)).toBe(true);
  expect(dragSession(sams)).toBe(false);
  // Growth is hosted by the viewer, so it still moves.
  expect(dragRole(org.roles[0])).toBe(true);
  await act(async () => {
    last().onReparentRequest({
      subject: { kind: "session", id: sams._id, title: sams.title },
      target: { kind: "user", user_id: ME },
      targetTitle: "Ashot",
      at: { x: 0, y: 0 },
    });
  });
  expect(m.writes("reparentOrgSession")).toEqual([]);
  await m.done();
});

test("People: a session or a role opens in the drawer beside the chart; a person opens the page they already have", async () => {
  const { done, navigationLog } = await mount();
  await act(async () => {
    last().onOpenSession!("fixture-session-1");
  });
  expect(navigationLog.at(-1)).toEqual({
    action: "push",
    path: "/org?session=fixture-session-1",
  });
  await act(async () => {
    last().onOpenObject!({ kind: "role", id: "fixture-role-growth" });
  });
  expect(navigationLog.at(-1)).toEqual({
    action: "push",
    path: "/org?session=fixture-growth-conv",
  });
  await act(async () => {
    last().onOpenObject!({ kind: "person", id: "nobody" });
  });
  expect(navigationLog.at(-1)).toEqual({
    action: "push",
    path: "/team/nobody",
  });
  await done();
});

test("a card opens in place from its toggle, and Expand all opens every card, is saved for the person, and Collapse all closes them", async () => {
  const { el, done, writes } = await mount();
  const role = `role:${ORG_FIXTURE.roles[0]._id}`;
  const session = `session:${ORG_FIXTURE.people[0].sessions[0]._id}`;
  expect(last().view.opened!.size).toBe(0);
  await act(async () => {
    last().onToggleOpen!(role);
  });
  expect([...last().view.opened!]).toEqual([role]);
  // What an open role lists comes from the store: here no projects or tasks, so empty lists, never a guess.
  expect(last().view.roleDetails![ORG_FIXTURE.roles[0]._id]).toEqual({
    leads: [],
    tasks: [],
  });
  await act(async () => {
    last().onToggleOpen!(role);
  });
  expect(last().view.opened!.size).toBe(0);
  // Expand all: every role and session card, saved as the person's own choice.
  expect(q("[data-org-expand-all='off']", el)!.textContent).toBe("Expand all");
  await act(async () => {
    q("[data-org-expand-all]", el)!.click();
  });
  expect(writes("updateClientUI").at(-1)).toEqual([{ org_expand_all: true }]);
  expect(last().view.opened!.has(role)).toBe(true);
  expect(last().view.opened!.has(session)).toBe(true);
  // A card closed by hand while it is on stays closed; the rest stay open.
  await act(async () => {
    last().onToggleOpen!(session);
  });
  expect(last().view.opened!.has(session)).toBe(false);
  expect(last().view.opened!.has(role)).toBe(true);
  expect(q("[data-org-expand-all='on']", el)!.textContent).toBe("Collapse all");
  await act(async () => {
    q("[data-org-expand-all]", el)!.click();
  });
  expect(writes("updateClientUI").at(-1)).toEqual([{ org_expand_all: false }]);
  expect(last().view.opened!.size).toBe(0);
  // Goals has no cards to open, so no control.
  await act(async () => {
    q("[data-org-view='goals']", el)!.click();
  });
  expect(q("[data-org-expand-all]", el)).toBeNull();
  await done();
});

test("the drawer: with no Head of People it offers the hire, behind the shared review; closed, the header brings it back", async () => {
  const { el, done, writes } = await mount();
  expect(q("[data-org-panel='home']", el)).not.toBeNull();
  expect(q("[data-org-panel-hire]", el)).not.toBeNull();
  // One press never hires: it opens the review that names what starts.
  await act(async () => {
    q("[data-hire-head]", el)!.click();
  });
  expect(q("[data-switch-review='Hire the Head of People']")).not.toBeNull();
  await act(async () => {
    [
      ...document.querySelectorAll<HTMLButtonElement>(
        "[data-switch-review] button",
      ),
    ]
      .find((b) => b.textContent?.startsWith("Not now"))!
      .click();
  });
  await waitForPopupClose();
  // Closing the drawer is the person's choice, kept; the header's control reopens it.
  await act(async () => {
    q("[data-line-drawer-close]", el)!.click();
  });
  expect(writes("updateClientUI").at(-1)).toEqual([{ org_panel: "closed" }]);
  expect(q("[data-org-panel]", el)).toBeNull();
  await act(async () => {
    q("[data-org-panel-open]", el)!.click();
  });
  expect(writes("updateClientUI")).toEqual([[{ org_panel: "closed" }], [{}]]);
  expect(q("[data-org-panel='home']", el)).not.toBeNull();
  expect(q("[data-org-panel-open]", el)).toBeNull();
  await done();
});

test("hiring an Executive Assistant is one confirmed press: the review names what starts, and only its confirm hires", async () => {
  const { el, done, writes } = await mount(
    "people",
    org,
    <HireAssistantCard compact />,
  );
  const reachInput = q("[data-assistant-reach='global'] input", el);
  await act(async () => {
    q("[data-assistant-hire]", el)!.click();
  });
  expect(
    reachInput?.isSameNode(q("[data-assistant-reach='global'] input", el)),
  ).toBe(true);
  expect(writes("hireExecutiveAssistant")).toEqual([]);
  expect(q("[data-switch-review='Hire Executive Assistant']")).not.toBeNull();
  await act(async () => {
    [
      ...document.querySelectorAll<HTMLButtonElement>(
        "[data-switch-review] button",
      ),
    ]
      .find((b) => b.textContent?.startsWith("Hire and start"))!
      .click();
  });
  expect(writes("hireExecutiveAssistant")).toEqual([
    [{ reach: { reach: "global" } }],
  ]);
  await waitForPopupClose();
  await done();
});
