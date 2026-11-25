import { expectAbsent, expectPresent } from "../../test-helpers/domExpect";
import { topLevelSelectors } from "../../lib/__tests__/sourceWalk";
// The role page is the session page (docs/architecture/
// initiatives-projects-role-page.md I3). The WHOLE inbox page is mounted over
// the real store, because the contract is about where every way of opening a
// session ends: they all set the pane's session, and the pane decides once.
//
//   four routes   a card (navigateToSession), the palette or a pill
//                 (requestNavigate), a link or the chart's route (?s=), and a
//                 stashed seat peeked at: each renders the role layout
//   a hand        a session that reports to a role keeps the session page
//   session view  the plain conversation lasts one visit: leaving the seat and
//                 coming back is the role page again, and "Role page" returns
//   the header    the seat's conversation keeps the session header (never
//                 hideHeader), the share control and the context panels, rests
//                 on one row and opens on demand
//   unknown role  a seat whose role the tree does not hold stays a session
//   an ask        Session view asked from another page lands while the pane
//                 already shows the seat, and settles once
//   a surface     the stage pane and the pop out window mount the same switch;
//                 their own end controls stay in both views
// Each test stands alone: every open is the card's whole gesture.
// Run: bun test components/__tests__/seatSessionPage.mount.test.tsx
import { api } from "@codecast/convex/convex/_generated/api";
import { afterAll, expect, mock, test } from "bun:test";
import { act } from "react";
import { webBuilders } from "../../test-helpers/builders";
import { ConversationLayoutStandIn } from "../../test-helpers/ConversationLayoutStandIn";
import { DashboardLayoutStandIn } from "../../test-helpers/DashboardLayoutStandIn";
import { mountWeb } from "../../test-helpers/mountWeb";
import { pending } from "../../test-helpers/testConvex";
import {
  useInboxStore,
  type InboxSession,
  type SessionRoleSnapshot,
} from "../../store/inboxStore";
import { ORG_FIXTURE } from "../org/orgFixture";

const SEAT = "seat0000000000000000000000000000";
const HAND = "hand0000000000000000000000000000";
const STRAY = "stray000000000000000000000000000";
const ROLE = "role-head";
const realDashboard = { ...(await import("../DashboardLayout")) };
mock.module("../DashboardLayout", () => ({
  ...realDashboard,
  DashboardLayout: DashboardLayoutStandIn,
}));
afterAll(() => mock.module("../DashboardLayout", () => realDashboard));
const realFleet = { ...(await import("../FleetBoard")) };
mock.module("../FleetBoard", () => ({
  ...realFleet,
  FleetBoard: () => <div data-fleet />,
  InboxHomeToggle: () => null,
}));
afterAll(() => mock.module("../FleetBoard", () => realFleet));
const realActivity = { ...(await import("../ActivityFeed")) };
mock.module("../ActivityFeed", () => ({
  ...realActivity,
  ActivityFeed: () => <div data-feed />,
}));
afterAll(() => mock.module("../ActivityFeed", () => realActivity));

const realTrigger = { ...(await import("../TriggerContextPanel")) };
mock.module("../TriggerContextPanel", () => ({
  ...realTrigger,
  TriggerContextPanel: () => <div data-trigger-panel />,
}));
afterAll(() => mock.module("../TriggerContextPanel", () => realTrigger));
const realPlaceholder = { ...(await import("../ConversationPlaceholder")) };
mock.module("../ConversationPlaceholder", () => ({
  ...realPlaceholder,
  ConversationPlaceholder: ({ id }: { id?: string }) => (
    <div data-placeholder={id} />
  ),
}));
afterAll(() =>
  mock.module("../ConversationPlaceholder", () => realPlaceholder),
);

// The session header lives in ConversationView; what the pane hands it is the
// contract here. Its slots render, so a control the pane forgot would be absent.
const realConversation = { ...(await import("../ConversationDiffLayout")) };
mock.module("../ConversationDiffLayout", () => ({
  ...realConversation,
  ConversationDiffLayout: ConversationLayoutStandIn,
}));
afterAll(() =>
  mock.module("../ConversationDiffLayout", () => realConversation),
);

const queuePage = await import("../../app/inbox/QueuePageClient");
const { SeatHeadControls } = await import("../org/scope/SeatHead");
const fixtures = webBuilders("seatSessionPage.mount.test.tsx");
const standingRole = fixtures.role.build({
  _id: ROLE,
  short_id: "or-10",
  name: "Head of People",
  status: "active",
  handle: "head-of-people",
});
const roleSnapshot: SessionRoleSnapshot = {
  _id: standingRole._id,
  name: standingRole.name,
  handle: standingRole.handle,
  avatar: "owl",
  short_id: standingRole.short_id,
  status: "active",
  tenure_kind: "standing",
};
const row = (id: string, extra: Partial<InboxSession>) =>
  fixtures.session.build({
    _id: id,
    title: id,
    updated_at: Date.now(),
    message_count: 3,
    ...extra,
  });

let web: Awaited<ReturnType<typeof mountWeb>> | undefined;
const mount = async (qs = "", rows: Record<string, InboxSession> = {}) => {
  await web?.close();
  web = await mountWeb(<queuePage.QueuePageClient />, {
    path: qs ? `/inbox?${qs}` : "/inbox",
    dispatch: true,
    setup: (backend, store) => {
      backend.mutation(api.dispatch.dispatch, null);
      store.syncTable("orgTree", { ...ORG_FIXTURE, roles: [standingRole] });
      store.syncTable(
        "sessions",
        Object.values({
          [SEAT]: row(SEAT, { standing_role_id: ROLE, role: roleSnapshot }),
          [HAND]: row(HAND, { org_role_id: ROLE, role: roleSnapshot }),
          [STRAY]: row(STRAY, {
            standing_role_id: "role-elsewhere",
            role: { ...roleSnapshot, _id: "role-elsewhere" },
          }),
          ...rows,
        }),
      );
      for (const id of [SEAT, HAND, STRAY, ...Object.keys(rows)]) {
        store.syncRecord("conversations", id, {
          _id: id,
          is_own: true,
          updated_at: Date.now(),
        });
        store.setMessages(id, [fixtures.message.build()]);
      }
      useInboxStore.setState({
        clientStateInitialized: true,
        showMySessions: false,
      });
      backend.set(api.org.roles, pending);
      backend.set(api.org.tree, pending);
      backend.set(api.org.scopeSummary, pending);
      backend.set(api.org.scopeFeed, { rows: [] });
      backend.set(api.orgTemplates.instanceForRole, pending);
      backend.set(api.org.brief, pending);
      backend.set(api.tasks.webActiveSessions, pending);
      backend.set(api.tasks.webListPaginated, pending);
      backend.set(api.docs.webListPaginated, pending);
      backend.set(api.devices.listDevices, pending);

      backend.set(api.conversations.getConversation, pending);
      backend.set(api.conversations.getConversationWithMeta, pending);
      backend.set(api.conversations.getTranscriptWatermark, pending);
      backend.set(api.conversations.getUserMessages, pending);
      backend.set(api.conversations.listMessagesTail, pending);
      backend.set(api.conversations.getAllMessages, pending);
    },
  });
};
// The role page arrives through React.lazy: wait out its placeholder.
const settle = async () => {
  for (let i = 0; i < 200; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, i < 4 ? 0 : 25));
    });
    if (i >= 3 && !document.querySelector("[data-placeholder]")) return;
  }
};
const q = (sel: string) => document.querySelector<HTMLElement>(sel);
const click = async (sel: string) => {
  const el = q(sel);
  expectPresent(el);
  await act(async () => el!.click());
  await settle();
};
const go = async (
  fn: (s: ReturnType<typeof useInboxStore.getState>) => void,
) => {
  await act(async () => fn(useInboxStore.getState()));
  await settle();
};
// A card, the chart's select, a fork chip: what the inbox's own click handler
// does. Leaving the home surface is part of the gesture, so every test stands
// alone whatever the store held before it.
const open = (id: string) =>
  go((s) => {
    s.navigateToSession(id);
    s.setShowMySessions(false);
  });
const expectRolePage = () => {
  expect(q("[data-scope-page]")?.getAttribute("data-scope-page")).toBe(ROLE);
  expect(q("[data-scope-head] h1")?.textContent).toBe("Head of People");
  expect(
    q("[data-scope-panel-toggle]")?.getAttribute("data-scope-panel-toggle"),
  ).toBe("closed");
  expect(q("[data-layout]")?.getAttribute("data-layout")).toBe(SEAT);
};

test("a seat opened by four routes renders the role layout", async () => {
  await mount();
  await open(SEAT);
  expectRolePage();

  await mount();
  await go((s) => s.requestNavigate(SEAT)); // the palette, a pill in prose
  expectRolePage();

  await mount(`s=${SEAT}`); // /conversation/<id> hands over to /inbox?s=<id>: a shared link, the chart's route
  await settle();
  expectRolePage();

  await mount();
  await go((s) => {
    s.setViewingDismissedId(SEAT);
    s.setShowMySessions(false);
  }); // a stashed seat, peeked at
  expectRolePage();
  await click("[data-scope-panel-toggle]");
  expect(q("[data-scope-aside]")?.getAttribute("data-scope-aside")).toBe(
    "side",
  );
  expect(q("[data-layout]")?.getAttribute("data-hide-diff")).toBe("1");
}, 600_000);

test("a hand keeps the session page, and so does a seat whose role the tree does not hold", async () => {
  await mount();
  await open(HAND);
  expectAbsent(q("[data-scope-page]"));
  expect(q("[data-layout]")?.getAttribute("data-layout")).toBe(HAND);
  expectAbsent(q("[data-seat-role-page]"));
  expectAbsent(q("[data-seat-head]"));

  await open(STRAY);
  expectAbsent(q("[data-scope-page]"));
  expect(q("[data-layout]")?.getAttribute("data-layout")).toBe(STRAY);
  expectAbsent(q("[data-seat-role-page]"));
}, 600_000);

test("Session view lasts one visit, and Role page returns within it", async () => {
  await mount();
  await open(SEAT);
  expectRolePage();

  await click("[data-seat-session-view]");
  expectAbsent(q("[data-scope-page]"));
  expect(q("[data-layout]")?.getAttribute("data-layout")).toBe(SEAT);
  expectAbsent(q("[data-seat-head]"));

  await click("[data-seat-role-page]");
  expectRolePage();

  await click("[data-seat-session-view]");
  await open(HAND);
  await open(SEAT);
  expectRolePage();
}, 600_000);

test("the role page asks for the plain view across the route, once", async () => {
  const { askSessionView } = await import("../../lib/sessionViewVisit");
  await mount();
  // The pane is already showing another session when the person arrives.
  await open(HAND);
  askSessionView(SEAT);
  await open(SEAT);
  expectAbsent(q("[data-scope-page]"));
  expectPresent(q("[data-seat-role-page]"));

  await open(HAND);
  await open(SEAT);
  expectRolePage();
}, 600_000);

// The tab shell keeps the inbox mounted: a person goes inbox, then the chart,
// then Session view, and the pane ALREADY shows that seat. The ask must still
// land, and a second ask after Role page must land again.
test("an ask lands while the pane already shows the seat", async () => {
  const { askSessionView } = await import("../../lib/sessionViewVisit");
  await mount();
  await open(SEAT);
  expectRolePage();

  await act(async () => askSessionView(SEAT));
  await settle();
  expectAbsent(q("[data-scope-page]"));
  expectPresent(q("[data-seat-role-page]"));

  await click("[data-seat-role-page]");
  expectRolePage();
  await act(async () => askSessionView(SEAT));
  await settle();
  expectAbsent(q("[data-scope-page]"));

  // Settled: leaving and returning is the role page again.
  await open(HAND);
  await open(SEAT);
  expectRolePage();
}, 600_000);

// The stage pane and the pop out window mount the same switch with their own
// end controls, which stay in the header in both views.
test("a surface's own end controls ride along in both views", async () => {
  await mount();
  await open(SEAT);

  const props = {
    sessionId: SEAT,
    isIdle: true,
    onSendAndAdvance: () => {},
    headerEnd: <button data-pane-close>close</button>,
  };
  await web!.rerender(<queuePage.SessionPage {...props} />);
  await settle();
  expectRolePage();
  expectPresent(q("[data-sv-convhead] [data-pane-close]"));
  expectPresent(q("[data-seat-session-view]"));
  await click("[data-seat-session-view]");
  expectAbsent(q("[data-scope-page]"));
  expectPresent(q("[data-sv-convhead] [data-pane-close]"));
  expectPresent(q("[data-seat-role-page]"));
}, 600_000);

test("the seat keeps the session header and every slot, folded behind the role header's expander", async () => {
  await mount();
  await open(SEAT);
  const layout = q("[data-layout]")!;
  expect(layout.getAttribute("data-hide-header")).toBe("0");
  expect(layout.getAttribute("data-density")).toBe("condensed");
  expectPresent(q("[data-sv-convhead] [data-share-trigger]"));
  expectPresent(q("[data-seat-label]"));
  expect(q("[data-lead]") === null).toBe(true);
  // At rest the routine line waits behind the expander, not above the first message.
  expectAbsent(q("[data-trigger-panel]"));

  expect(q("[data-seat-head]")?.getAttribute("data-seat-head")).toBe("rest");
  await click("[data-seat-head-toggle]");
  expect(q("[data-seat-head]")?.getAttribute("data-seat-head")).toBe("open");
  expectPresent(q("[data-trigger-panel]"));
  // The state slot leaves the DOM, which is what makes the row's squeeze measure again.
  expectAbsent(q("[data-seat-label]"));
  expect(q("[data-seat-head-toggle]")?.getAttribute("aria-expanded")).toBe(
    "true",
  );
  await click("[data-seat-head-toggle]");
  expect(q("[data-seat-head]")?.getAttribute("data-seat-head")).toBe("rest");
}, 600_000);

test("a stall replaces the state word at rest; the banner waits behind the expander", async () => {
  // The stall arrives with the row, as it does from the sync.
  await mount("", {
    [SEAT]: row(SEAT, {
      standing_role_id: ROLE,
      role: roleSnapshot,
      session_error: "the agent died",
    }),
  });
  await open(HAND);
  await open(SEAT);
  expectRolePage();
  expect(q("[data-seat-head]")?.hasAttribute("data-seat-stall")).toBe(true);
  expect(q("[data-seat-stall]")?.textContent).toContain("Session error");
  expect(q("[data-seat-stall-action]")?.textContent).toBe("Resume");
  expect(document.body.textContent).not.toContain("the agent died");

  await click("[data-seat-head-toggle]");
  expect(q("[data-seat-head]")?.hasAttribute("data-seat-stall")).toBe(false);
  expect(document.body.textContent).toContain("the agent died");
}, 600_000);

// The fold is CSS over the real header, so no action is rebuilt and none can
// be lost: at rest it hides, and the open state hides no action.
test("the fold only hides at rest", async () => {
  const css = (
    await Bun.file(new URL("../../app/globals.css", import.meta.url)).text()
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [
    ...css.matchAll(/([^{}]*\[data-seat-head[^{}]*)\{([^}]*)\}/g),
  ].map((m) => ({ sel: m[1].replace(/\s+/g, " "), body: m[2] }));
  expect(rules.length).toBeGreaterThan(0);
  for (const r of rules.filter((x) => /display:\s*none/.test(x.body))) {
    for (const sel of topLevelSelectors(r.sel)) {
      // Open hides only what the role's header already says: the title and the face before it.
      const repeatsTheRoleHeader =
        /\[data-seat-head="open"\].*(\.cq-squeeze-row > h1|\.cq-squeeze-row > :has\(\+ h1\))\s*$/.test(
          sel.trim().replace(/\s+/g, " "),
        );
      expect(
        /\[data-seat-head="rest"\]/.test(sel) || repeatsTheRoleHeader,
      ).toBe(true);
    }
  }
  const rest = rules.find((x) => x.sel.includes("cq-squeeze-row"))!;
  for (const kept of [
    "[data-cc-conv-status]",
    "[data-cc-conv-actions]",
    "input",
  ])
    expect(rest.sel.includes(kept)).toBe(true);
  expect(
    rules.some((x) =>
      x.sel.includes("[data-cc-conv-actions] > :not([data-cc-keep])"),
    ),
  ).toBe(true);
});

test("a seat of another workspace than the active one holds the org to its own and opens as the role page", async () => {
  const FOREIGN = "foreign00000000000000000000000000";
  const other: SessionRoleSnapshot = {
    ...roleSnapshot,
    short_id: "or-20",
    _id: "role-other",
    name: "Market Growth lead",
    handle: "market-growth",
    avatar: "owl",
  };
  await mount("", {
    [FOREIGN]: row(FOREIGN, {
      standing_role_id: other._id,
      role: other,
      team_id: "team-b",
    }),
  });
  await act(async () => {
    const state = useInboxStore.getState();
    state.syncTable("currentUser", { _id: "me" });
    state.syncTable("clientState", { ui: { active_team_id: "team-a" } });
    state.syncTable("orgTree", {
      ...ORG_FIXTURE,
      workspace: { ...ORG_FIXTURE.workspace, id: "team-a" },
      roles: [standingRole],
    });
  });
  await act(async () => {
    const s = useInboxStore.getState();
    s.navigateToSession(FOREIGN);
    s.setShowMySessions(false);
  });
  // The held tree is the active workspace's: the pane waits for the seat's own, never flashing the plain session.
  expect(useInboxStore.getState().orgScope).toBe("team:team-b");
  expect(q("[data-placeholder]")?.getAttribute("data-placeholder")).toBe(
    FOREIGN,
  );
  expectAbsent(q("[data-layout]"));

  await go((state) =>
    state.syncTable("orgTree", {
      ...ORG_FIXTURE,
      workspace: { ...ORG_FIXTURE.workspace, id: "team-b" },
      roles: [
        fixtures.role.build({
          _id: other._id,
          short_id: other.short_id,
          name: other.name,
          handle: other.handle,
        }),
      ],
    }),
  );
  expect(q("[data-scope-page]")?.getAttribute("data-scope-page")).toBe(
    other._id,
  );
  expect(q("[data-layout]")?.getAttribute("data-layout")).toBe(FOREIGN);

  // Leaving the seat gives the window's org back to the active workspace.
  await open(HAND);
  expect(useInboxStore.getState().orgScope).toBeNull();
}, 600_000);
