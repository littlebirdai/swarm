import { afterAll, afterEach, expect, test } from "bun:test";
import { api } from "@codecast/convex/convex/_generated/api";
import { isHeadOfPeopleRole } from "@codecast/org/orgLead";
import { act } from "react";
import { _resetTrailForTests, recordTrail } from "../../lib/navTrail";
import { parseTabLocation, TabParamsCtx } from "../../lib/tabParams";
import { webBuilders } from "../../test-helpers/builders";
import { expectAbsent, expectPresent } from "../../test-helpers/domExpect";
import { mountWeb } from "../../test-helpers/mountWeb";
import { standInForOrgGraph } from "../../test-helpers/orgGraphStandIn";
import { pending } from "../../test-helpers/testConvex";
import { OrgChart } from "./OrgChart";
import { ORG_FIXTURE_WITH_HEAD } from "./orgFixture";

const builders = webBuilders("OrgChart.closeProposal.mount.test.tsx");
const viewer = builders.teamMember.build();
const session = builders.session.build();
const headMessage = "The Head of People has the staffing proposal.";
const row = builders.message.build({ content: headMessage, role: "assistant" });
const tree = {
  ...ORG_FIXTURE_WITH_HEAD,
  roles: ORG_FIXTURE_WITH_HEAD.roles.map((role) =>
    isHeadOfPeopleRole(role) && role.standing
      ? {
          ...role,
          standing: { ...role.standing, conversation_id: session._id },
        }
      : role,
  ),
};
const proposalPath = "/org?proposal=op-7";
const draft = "Thanks, one question before I approve";

let graph: ReturnType<typeof standInForOrgGraph> | undefined;
afterEach(_resetTrailForTests);
afterAll(() => graph?.restore());

function mount(path: string, opts: { tab?: boolean; trail?: boolean } = {}) {
  graph ??= standInForOrgGraph();
  const page = <OrgChart />;
  return mountWeb(
    opts.tab ? (
      <TabParamsCtx.Provider
        value={{
          tabId: "test-tab",
          ...parseTabLocation(path),
          params: {},
          isActive: true,
          isVisible: true,
        }}
      >
        {page}
      </TabParamsCtx.Provider>
    ) : (
      page
    ),
    {
      path,
      authenticated: true,
      dispatch: true,
      setup(backend, store) {
        store.syncTable("currentUser", viewer);
        store.syncTable("clientState", {
          ui: { org_view: "people", active_team_id: tree.workspace.id },
        });
        store.syncTable("orgTree", tree);
        store.syncTable("sessions", [session]);
        store.setMessages(session._id, [row], {
          initialized: true,
          hasMoreAbove: false,
        });
        backend.set(api.conversations.listMessages, pending);
        backend.set(api.conversations.listMessagesTail, pending);
        backend.set(api.conversations.getConversationWithMeta, pending);
        backend.set(api.conversations.getTranscriptWatermark, pending);
        backend.set(api.conversations.getUserMessages, pending);
        backend.set(api.accountSwitch.listAccountProfiles, pending);
        backend.set(api.collab.mySendAccess, pending);
        backend.set(api.commentTwins.conversationComments, pending);
        backend.set(api.commits.getCommitsForConversation, pending);
        backend.set(api.conversationPages.list, pending);
        backend.set(api.devices.listDevices, pending);
        backend.set(api.docSync.getPresence, pending);
        backend.set(api.externalEvents.listForConversation, pending);
        backend.set(api.guestSuggestions.listPending, pending);
        backend.set(api.messages.getConversationFileChangeIndex, pending);
        backend.set(api.messages.getConversationImages, pending);
        backend.set(api.pendingMessages.getConversationPendingMessage, pending);
        backend.set(api.permissions.getPendingPermissions, pending);
        backend.set(api.pull_requests.getPRsForConversation, pending);
        backend.set(api.pull_requests.sessionCardPRs, pending);
        backend.set(api.quoteDrafts.listForConversation, pending);
        backend.set(api.sessionGoals.forConversation, pending);
        backend.set(api.sessionOwnership.listOwners, pending);
        backend.set(api.tasks.webListByConversation, pending);
        backend.set(api.teamSuggestions.listMine, pending);
        backend.set(api.transcripts.webCallsForConversation, pending);
        backend.set(api.users.getMySkills, pending);
        backend.set(api.workflows.webList, pending);
        backend.set(api.org.tree, pending);
        backend.set(api.org.roles, pending);
        backend.set(api.org.sessionsUnder, pending);
        backend.set(api.orgProposals.get, pending);
        backend.set(api.orgProposals.list, pending);
        backend.set(api.projects.webList, pending);
        backend.action(api.orgHealth.healthReport, undefined);
        backend.mutation(api.dispatch.dispatch, null);
        backend.mutation(api.users.requestTerminalEndpoints, undefined);
        backend.mutation(api.docSync.updatePresence, undefined);
        backend.mutation(api.docSync.removePresence, undefined);
        if (opts.tab) {
          store.syncTable("clientState", {
            tabs: [{ id: "test-tab", path, title: "", createdAt: 0 }],
            activeTabId: "test-tab",
          });
        }
        if (opts.trail) {
          store.setDraft(session._id, { draft_message: draft });
          recordTrail("test-tab", "/conversation/" + session._id, "push");
          recordTrail("test-tab", path, "push");
        }
      },
    },
  );
}

type Mount = Awaited<ReturnType<typeof mount>>;
const close = (web: Mount) =>
  act(async () => {
    const button = web.container.querySelector<HTMLButtonElement>(
      "[data-line-drawer-close]",
    );
    expectPresent(button);
    button.click();
  });
const expectOpenDrawer = (web: Mount) => {
  const panel = web.container.querySelector("[data-org-panel=home]");
  expectPresent(panel);
  expect(panel.textContent).toContain(headMessage);
  expect(web.backend.queryRequests).toContainEqual({
    name: "transcripts:webCallsForConversation",
    args: { conversation_id: session._id },
  });
  expectAbsent(web.container.querySelector("[data-org-panel-open]"));
};
const expectNoCloseWrite = (web: Mount) => {
  expect(
    web.backend.mutations.filter(
      ({ args }) =>
        typeof args === "object" &&
        args !== null &&
        "action" in args &&
        args.action === "updateClientUI",
    ),
  ).toEqual([]);
  expect(web.store.getState().clientState.ui?.org_panel).not.toBe("closed");
};

test("closing a proposal opened from the Head of People's thread returns to that thread and keeps the drawer open on later visits", async () => {
  const home = await mount("/org");
  expectOpenDrawer(home);
  await home.close();

  const web = await mount(proposalPath);
  expectPresent(web.container.querySelector("[data-org-panel=proposal]"));
  await close(web);
  expect(web.navigationLog.slice(1)).toEqual([
    { action: "push", path: "/org" },
  ]);
  expectNoCloseWrite(web);
  expectOpenDrawer(web);
});

test("Close on a proposal opened from the Head of People's conversation goes back to that conversation in one press, draft intact, never via bare /org", async () => {
  const web = await mount(proposalPath, { tab: true, trail: true });
  const historyLength = window.history.length;
  await close(web);
  expect(web.store.getState().currentSessionId).toBe(session._id);
  expect(window.history.length).toBe(historyLength + 1);
  expect(window.location.pathname + window.location.search).toBe(
    "/inbox?s=" + session._id,
  );
  expect(web.store.getState().getDraft(session._id)?.draft_message).toBe(draft);
  expectNoCloseWrite(web);
});

test("Close on a proposal reached by a pasted link, with nothing to go back to, lands on /org with the drawer open", async () => {
  const web = await mount(proposalPath, { tab: true });
  const historyLength = window.history.length;
  await close(web);
  expect(window.history.length).toBe(historyLength + 1);
  expect(window.location.pathname + window.location.search).toBe("/org");
  expectNoCloseWrite(web);
  await web.close();

  const home = await mount("/org", { tab: true });
  expectOpenDrawer(home);
});
