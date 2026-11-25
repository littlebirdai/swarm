import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { afterAll, afterEach, mock, spyOn, test } from "bun:test";
import { getFunctionName } from "convex/server";
import assert from "node:assert/strict";
import { act, type ReactNode } from "react";
import {
  useLocation,
  useNavigate,
  useNavigationType,
  type NavigateFunction,
} from "react-router";
import { ORG_FIXTURE } from "../../../components/org/orgFixture";
import { AUTH_JWT_STORAGE_KEY } from "../../../lib/localAuth";
import type { DispatchCallArgs } from "../../../lib/dispatchBinding";
import { useInboxStore } from "../../../store/inboxStore";
import { webBuilders } from "../../../test-helpers/builders";
import { mountWeb } from "../../../test-helpers/mountWeb";
import { waitForDom } from "../../../test-helpers/waitForDom";

const realShell = { ...(await import("../../../components/DashboardLayout")) };
mock.module("../../../components/DashboardLayout", () => ({
  ...realShell,
  DashboardLayout: ({ children }: { children: ReactNode }) => children,
}));
afterAll(() =>
  mock.module("../../../components/DashboardLayout", () => realShell),
);

const { default: ProjectDetailPage } = await import("./page");

const TEAM = "p".repeat(32);
const fixtures = webBuilders("ProjectHeader.mount.test.tsx");
const endOfLocalDay = (y: number, m: number, d: number) =>
  new Date(y, m - 1, d, 23, 59, 59).getTime();
const project = fixtures.project.build({
  short_id: "pj-agentorg",
  title: "Agent org",
  status: "active",
  color: "violet",
  workspace: "team:" + TEAM,
  team_id: TEAM,
  description: "The org chart, roles and scopes.",
  project_path: "~/src/codecast",
  target_date: endOfLocalDay(2026, 11, 1),
});
const PID = project._id;
const task = fixtures.task.build({
  title: "Review the rollout",
  workspace: `team:${TEAM}`,
  project_id: PID,
  promoted: true,
});

let restoreTime: (() => void) | undefined;
afterEach(() => {
  restoreTime?.();
  restoreTime = undefined;
});

async function setup(
  id = project.short_id!,
  search = "",
  row = project,
  phone = false,
) {
  const now = spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 8, 18, 12));
  restoreTime = () => now.mockRestore();
  let navigate: NavigateFunction;
  function View() {
    navigate = useNavigate();
    const location = useLocation();
    return (
      <>
        <output hidden data-project-location>
          {location.pathname + location.search}
        </output>
        <output hidden data-navigation-type>
          {useNavigationType()}
        </output>
        <ProjectDetailPage />
      </>
    );
  }
  const web = await mountWeb(<View />, {
    path: "/projects/" + id + search,
    route: "/projects/:id/:taskId?",
    authenticated: true,
    dispatch: true,
    setup: (backend, store) => {
      localStorage.setItem(AUTH_JWT_STORAGE_KEY, "fixture-jwt");
      if (phone) {
        const wideMedia = window.matchMedia;
        window.matchMedia = (query) => ({
          ...wideMedia(query),
          matches: /max-width: (?:767|639)px/.test(query),
        });
      }
      store.syncTable("currentUser", { _id: "fixture-user-me", name: "Ashot" });
      store.syncTable("clientState", { ui: { active_team_id: TEAM } });
      useInboxStore.setState({ clientStateInitialized: true });
      store.syncTable("teams", [
        { _id: TEAM, name: "Fixture", features: { line: true } },
        { _id: "home-team", name: "Codecast" },
      ]);
      store.syncTable("projects", [row]);
      store.syncTable("tasks", [task]);
      store.syncTable("orgTree", {
        ...ORG_FIXTURE,
        workspace: { ...ORG_FIXTURE.workspace, id: TEAM },
      });
      store.syncTable("initiatives", [
        {
          _id: "init-org",
          short_id: "in-1",
          title: "Agents run the company's routine work",
          status: "active",
          project_ids: [PID],
          health: "at_risk",
          workspace: "team:" + TEAM,
          team_id: TEAM,
          user_id: "fixture-user-me",
          created_at: 0,
          updated_at: 0,
        },
      ]);
      backend.set(api.projects.webGet, {
        title: project.title,
        status: "active",
        description: project.description,
        target_date: project.target_date,
        workspace: project.workspace,
        short_id: project.short_id,
        created_at: project.created_at,
        updated_at: project.updated_at,
        _id: PID as Id<"projects">,
        _creationTime: 0,
        team_id: TEAM as Id<"teams">,
        user_id: "fixture-user-me" as Id<"users">,
      });
      backend.set(api.projects.webList, undefined);
      backend.set(api.org.roles, undefined);
      backend.set(api.tasks.webList, undefined);
      backend.set(api.tasks.webActiveSessions, undefined);
      backend.set(api.devices.listDevices, undefined);

      backend.set(api.tasks.webListPaginated, {
        page: [],
        isDone: true,
        continueCursor: "",
      });
      backend.set(api.assistant.incidents.thinkingAvailable, undefined);
      backend.set(api.initiatives.webGet, undefined);
      backend.set(api.projectUpdates.webTimeline, []);
      backend.set(api.projectUpdates.webList, undefined);
      backend.set(api.externalEvents.listForProject, undefined);
      backend.set(api.projectSources.teammateSources, undefined);

      backend.set(api.signals.webList, undefined);
      backend.set(api.workflow_runs.listRuns, undefined);
      backend.set(api.workflows.webGetBySlug, undefined);
      backend.set(api.org.tree, undefined);
      backend.set(api.lineWorkspace.labels, undefined);
      backend.set(api.lineWorkspace.occurrences, undefined);
      backend.set(api.lineWorkspace.deploys, undefined);
      backend.set(api.lineWorkspace.cards, undefined);
      backend.set(api.lineTrial.cards, undefined);
      backend.set(api.lineTrial.projects, undefined);
      backend.set(api.lineTrial.runs, undefined);
    },
  });
  const asked = () =>
    web.backend.queryRequests
      .filter(({ name }) => name === getFunctionName(api.projects.webGet))
      .map(({ args }) => args);
  const q = <T extends Element = HTMLElement>(sel: string) =>
    document.querySelector<T>(sel);
  const qa = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
  const location = () => q("[data-project-location]")!.textContent;
  const go = (tab: string) =>
    act(async () => navigate("/projects/pj-agentorg?tab=" + tab));
  const updates = (field: string) =>
    web.backend.mutations.flatMap(({ args }) => {
      const { action, args: params } = args as DispatchCallArgs;
      return action === "updateProject" && field in params[1]
        ? [{ id: params[0], fields: params[1] }]
        : [];
    });
  const click = async (el: Element | null | undefined) => {
    assert.ok(el, "missing element");
    await act(async () => (el as HTMLElement).click());
  };
  const type = async (el: Element | null, value: string) => {
    assert.ok(el, "missing field");
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!.call(el, value);
      el.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  };
  const key = (el: Element | null, k: string) =>
    act(async () =>
      el!.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: k, bubbles: true }),
      ),
    );
  const blur = (el: Element | null) =>
    act(async () =>
      el!.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true })),
    );
  return { q, qa, asked, location, go, click, type, key, blur, updates, web };
}

test("an older project link moves to the canonical address and queries by Convex id", async () => {
  const { q, asked, location } = await setup(PID);
  assert.equal(
    q("[data-project-page]")?.getAttribute("data-project-page"),
    PID,
  );
  assert.equal(location(), "/projects/pj-agentorg");
  assert.equal(q("[data-navigation-type]")?.textContent, "REPLACE");
  assert.ok(asked().length > 0);
  assert.deepEqual(asked(), [{ id: PID }]);
});

test("the canonical address keeps the session view and its compact header", async () => {
  const { q, qa, click, location, web } = await setup();
  assert.equal(location(), "/projects/pj-agentorg");
  assert.equal(q("[data-navigation-type]")?.textContent, "POP");
  assert.equal(
    q("[data-project-page]")?.getAttribute("data-scope-tab-active"),
    "sessions",
  );
  assert.ok(q("[data-project-conversation]"));
  const header = q("[data-intent-header]")!;
  assert.ok(header);
  assert.equal(header.querySelectorAll("[data-intent-row]").length, 1);
  assert.equal(q("[data-intent-stripe]"), null);
  assert.equal(q("[data-intent-back]")?.getAttribute("href"), "/projects");
  const title = q("[data-project-title]")!;
  assert.equal(title.textContent, "Agent org");
  assert.equal(title.tagName, "H1");
  assert.equal(title.getAttribute("title"), "Agent org");
  assert.equal(q("[data-intent-id]"), null);
  assert.equal(q("[data-project-pick='target']"), null);
  assert.equal(q("[data-project-back-to-session]"), null);
  assert.ok(q("[data-project-view='sessions']"));
  assert.equal(web.store.getState().activeProjectFilter, "pj:" + PID);
  assert.equal(q("[data-project-inbox-filter]"), null);
  assert.equal(
    q("[data-share-trigger]")?.getAttribute("aria-label"),
    "Share project",
  );
  await click(q("[data-share-trigger]"));
  const copy = qa("button").find(
    (button) => button.textContent === "Copy link",
  );
  assert.ok(copy?.title);
  assert.equal(new URL(copy.title).pathname, "/projects/pj-agentorg");
});

test("the header shows additional facts outside the Session view", async () => {
  const { q, go, click, location } = await setup(
    project.short_id,
    "?tab=tasks",
  );
  assert.equal(
    q("[data-project-page]")?.getAttribute("data-scope-tab-active"),
    "tasks",
  );
  assert.match(document.body.textContent!, /Review the rollout/);
  assert.equal(q("[data-project-conversation]"), null);
  assert.ok(q("[data-project-view='tasks']"));
  assert.equal(q("[data-intent-id]")?.textContent, "pj-agentorg");
  const chips = q("[data-intent-chips]")!;
  assert.match(
    chips.querySelector("[data-project-pick='status']")!.textContent!,
    /Active/,
  );
  assert.ok(chips.querySelector("[data-project-lead]"));
  const deadline = q("[data-project-pick='target']")!;
  assert.equal(deadline.getAttribute("data-intent-target"), "2026-11-01");
  assert.equal(
    deadline
      .querySelector("[data-initiative-target]")
      ?.getAttribute("data-initiative-target"),
    "ahead",
  );
  const partOf = chips.querySelector("[data-project-initiatives]")!;
  assert.match(partOf.textContent!, /^Serves/);
  assert.match(partOf.textContent!, /Agents run the company's routine work/);
  const header = q("[data-intent-header]")!;
  for (const selector of [
    "[data-charter]",
    "[data-inline-edit='Project folder']",
    "[data-repository-links]",
  ]) {
    assert.equal(header.querySelector(selector), null, selector);
  }
  assert.doesNotMatch(header.textContent!, /The org chart, roles and scopes\./);
  await go("timeline");
  assert.equal(
    q("[data-project-page]")?.getAttribute("data-scope-tab-active"),
    "timeline",
  );
  assert.equal(
    q("[data-project-timeline]")?.getAttribute("data-project-timeline"),
    PID,
  );
  assert.doesNotMatch(document.body.textContent!, /Review the rollout/);
  await go("about");
  assert.ok(q("[data-project-about-tab]"));
  assert.ok(q("[data-charter]"));
  await click(q("[data-project-back-to-session]"));
  assert.equal(location(), "/projects/pj-agentorg");
  assert.ok(q("[data-project-conversation]"));
  await go("updates");
  assert.equal(
    q("[data-project-page]")?.getAttribute("data-scope-tab-active"),
    "timeline",
  );
});

test("title and status display store writes while the server still holds the old data", async () => {
  const { q, qa, click, type, key, updates, web } = await setup(
    project.short_id,
    "?tab=tasks",
  );
  await click(q("[data-project-title]"));
  await type(q("input[aria-label='Project title']"), "Agent organisation");
  await key(q("input[aria-label='Project title']"), "Enter");
  assert.deepEqual(updates("title"), [
    { id: PID, fields: { title: "Agent organisation" } },
  ]);
  assert.equal(q("[data-project-title]")!.textContent, "Agent organisation");
  await click(q("[data-project-pick='status']"));
  await click(
    qa("[role=dialog] button").find(
      (button) => button.textContent?.trim() === "Done",
    ),
  );
  assert.deepEqual(updates("status"), [
    { id: PID, fields: { status: "done" } },
  ]);
  await act(async () =>
    waitForDom(
      web.container,
      () =>
        !!q("[data-sonner-toast]")?.textContent?.includes(
          "Project marked as done",
        ),
    ),
  );
  assert.match(q("[data-project-pick='status']")!.textContent!, /Done/);
  const server = await web.backend.client.query(api.projects.webGet, {
    id: PID as Id<"projects">,
  });
  assert.equal(server?.title, "Agent org");
  assert.equal(server?.status, "active");
});

test("the deadline validates and saves the selected local day, or clears it", async () => {
  const { click, q, type, blur, updates } = await setup(
    project.short_id,
    "?tab=tasks",
  );
  const deadline = () => q<HTMLElement>("button[data-project-pick='target']");
  const field = () =>
    q<HTMLInputElement>("[data-project-pick='target'] input[type='date']");
  await click(deadline());
  assert.equal(field()!.value, "2026-11-01");
  await type(field(), "0002-11-01");
  assert.deepEqual(updates("target_date"), []);
  await blur(field());
  assert.deepEqual(updates("target_date"), []);
  await click(deadline());
  await type(field(), "2026-12-24");
  assert.deepEqual(updates("target_date"), []);
  await blur(field());
  assert.deepEqual(updates("target_date"), [
    { id: PID, fields: { target_date: endOfLocalDay(2026, 12, 24) } },
  ]);
  assert.equal(deadline()!.getAttribute("data-intent-target"), "2026-12-24");
  await click(deadline());
  await click(q("[data-project-pick='target'] [data-intent-target-clear]"));
  assert.deepEqual(updates("target_date").at(-1), {
    id: PID,
    fields: { target_date: null },
  });
  assert.equal(deadline()!.getAttribute("data-intent-target"), "");
  assert.match(deadline()!.textContent!, /No deadline/);
});

test("an uncached short id waits without asking the server for a Convex id", async () => {
  const { asked } = await setup("pj-unknown");
  assert.match(document.body.textContent!, /Loading project/);
  assert.deepEqual(asked(), []);
});

test("the phone title uses two lines and keeps the full title as its tooltip", async () => {
  const { q } = await setup(
    project.short_id,
    "",
    { ...project, title: "Agent organisation" },
    true,
  );
  assert.match(q("[data-project-title]")!.className, /line-clamp-2/);
  assert.equal(
    q("[data-project-title]")!.getAttribute("title"),
    "Agent organisation",
  );
});

test("a project from another workspace lets the person read Flow only", async () => {
  const { go, q } = await setup(project.short_id, "", {
    ...project,
    workspace: "team:home-team",
  });
  assert.match(
    q("[data-foreign-workspace]")!.textContent!,
    /This project lives in Codecast\. Switch to see its tasks\./,
  );
  assert.doesNotMatch(document.body.textContent!, /Review the rollout/);
  assert.equal(q("[data-project-line-tab]"), null);
  await go("line");
  assert.match(
    q("[data-foreign-workspace]")!.textContent!,
    /This project lives in Codecast\. You are reading its flow from here; switch to work in it\./,
  );
  assert.ok(q("[data-project-line-tab]"));
  assert.doesNotMatch(document.body.textContent!, /Review the rollout/);
});
