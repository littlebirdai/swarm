import { afterEach, expect, spyOn, test } from "bun:test";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import type { FunctionReturnType } from "convex/server";
import { act } from "react";
import { testFaker } from "@codecast/test-helpers/faker";
import type { LocalFolder } from "../../../lib/fsBrowse";
import { flushSyncPublishes } from "../../../store/syncTransaction";
import { webBuilders } from "../../../test-helpers/builders";
import { expectAbsent, expectPresent } from "../../../test-helpers/domExpect";
import { mountWeb } from "../../../test-helpers/mountWeb";
import { expectToast } from "../../../test-helpers/expectToast";
import SyncPage from "./page";

const DAY = 86_400_000;
const HEALTH = "/Users/me/health";
const CLONE = "/Users/me/src/app-clone";
const SITE = "/Users/me/src/site";
const QUIET = "/Users/me/src/quiet";
const OUTREACH = "/Users/me/src/old/outreach";
const LIVE = "/Users/me/src/live";
const users = api.users;
const seed = "settings/sync/page.mount.test.tsx";
type RecentProject = FunctionReturnType<
  typeof users.getRecentProjectsWithGitInfo
>[number];
type Mapping = FunctionReturnType<
  typeof users.getDirectoryTeamMappings
>[number];
type Store = Awaited<ReturnType<typeof mountWeb>>["store"];

function recentProject(
  row: Pick<
    RecentProject,
    "path" | "is_git_repo" | "session_count" | "last_active"
  > &
    Partial<RecentProject>,
): RecentProject {
  return {
    git_remote_url: undefined,
    repository: undefined,
    first_active: row.last_active,
    auto_share: false,
    private: false,
    mapped_directly: false,
    share_since: null,
    team_id: null,
    ...row,
  };
}

function changeInput(el: HTMLInputElement, value: string) {
  return act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const click = (el: HTMLElement) => act(async () => el.click());
const text = () => document.body.textContent ?? "";
const buttons = () => [...document.querySelectorAll("button")];
const byText = (label: string) =>
  buttons().find((b) => b.textContent?.trim() === label);
const byLabel = (label: string) =>
  buttons().find((b) => b.getAttribute("aria-label") === label) ?? null;
const panel = () => document.querySelector("[data-share-panel]");
const panelText = () => panel()?.textContent ?? "";
const chips = () => [
  ...panel()!.querySelectorAll<HTMLButtonElement>("[role=radio]"),
];
const apply = () => [...panel()!.querySelectorAll("button")].at(-1)!;
const scopes = () => [
  ...panel()!.querySelectorAll<HTMLInputElement>("input[name=share-scope]"),
];
let restoreFetch: (() => void) | undefined;
afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
});

function fixtures() {
  const { conversation, teamMember } = webBuilders(seed);
  const faker = testFaker(seed);
  const id = () => faker.string.alphanumeric({ length: 32, casing: "lower" });
  const now = Date.now();
  const member = teamMember.build();
  const team = {
    _id: id() as Id<"teams">,
    name: "Union",
    visibility: "full",
    member_count: 3,
  };
  const lock = (path: string, repository?: string): Mapping => ({
    _id: id() as Id<"directory_team_mappings">,
    path_prefix: path,
    team_id: null,
    team_name: null,
    auto_share: false,
    private: true,
    share_since: undefined,
    repository,
    created_at: now,
  });
  const appointment = conversation.build({
    title: "Appointment notes",
    started_at: now - DAY,
    message_count: 4,
  });
  const oldScan = conversation.build({
    title: "Old scan",
    started_at: now - 5 * DAY,
    message_count: 2,
    team_visibility: "private",
  });
  const state = {
    user: {
      ...member,
      sync_mode: "all" as "all" | "selected",
      sync_projects: [] as string[],
      sync_excluded: [] as string[],
    },
    teams: [] as (typeof team)[],
    projects: [] as RecentProject[],
    mappings: [] as Mapping[],
    local: null as LocalFolder[] | null,
    gone: [] as string[],
    failNext: false,
  };
  const requests: URL[] = [];
  const reply = async (...[target, options]: Parameters<typeof fetch>) => {
    const url = new URL(String(target));
    requests.push(url);
    if (
      url.origin !== "http://127.0.0.1:42871" ||
      new Headers(options?.headers).get("Authorization") !==
        "Bearer test-daemon"
    ) {
      return new Response(null, { status: 403 });
    }
    if (url.pathname === "/fs/sessions") {
      return Response.json(state.local ? { folders: state.local } : null);
    }
    if (url.pathname === "/fs/exists") {
      const paths = url.searchParams.getAll("p");
      return Response.json({
        home: "/Users/me",
        exists: Object.fromEntries(
          paths.map((path) => [path, !state.gone.includes(path)]),
        ),
      });
    }
    return new Response(null, { status: 404 });
  };
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(reply, { preconnect: fetch.preconnect }),
  );
  restoreFetch = () => fetchSpy.mockRestore();

  const syncViewer = (store: ReturnType<Store["getState"]>) => {
    store.syncTable("currentUser", state.user);
    store.syncTable("teams", state.teams);
    flushSyncPublishes();
  };
  const load = (expectFailedSave = false) =>
    mountWeb(<SyncPage />, {
      path: "/settings/sync",
      dispatch: true,
      expectedConsoleErrors: expectFailedSave
        ? [
            /\[CONVEX M\(users:updateSyncSettings\)\].*Server Error/,
            /^Failed to add folder:/,
          ]
        : [],
      setup(backend, store) {
        localStorage.setItem("CAST_TERM_ENDPOINT", "42871:test-daemon");
        syncViewer(store);
        backend.set(api.accountSwitch.listAccountProfiles, { devices: [] });
        backend.set(api.devices.listDevices, []);
        backend.mutation(api.dispatch.dispatch, ({ action }) =>
          action === "setPrivacy"
            ? null
            : new Error("Unexpected store action: " + action),
        );
        backend.set(users.getRecentProjectsWithGitInfo, ({ limit }) =>
          limit === 100 ? state.projects : [],
        );
        backend.set(users.getDirectoryTeamMappings, () => state.mappings);
        backend.set(users.shareImpactForPaths, ({ path_prefixes, since }) =>
          Object.fromEntries(
            path_prefixes.map((path) => {
              const hasHistory = path === HEALTH && since !== undefined;
              return [
                path,
                {
                  count: hasHistory ? 2 : 0,
                  first_started_at: hasHistory ? oldScan.started_at : null,
                  last_started_at: hasHistory ? appointment.started_at : null,
                  truncated: false,
                  older: 0,
                  older_than_day: 0,
                  hidden: hasHistory ? 1 : 0,
                  manually_shared: 0,
                },
              ];
            }),
          ),
        );
        backend.set(
          users.listConversationsForPath,
          ({ path_prefixes, limit }) =>
            path_prefixes.length === 1 &&
            path_prefixes[0] === HEALTH &&
            limit === 50
              ? {
                  rows: [appointment, oldScan].map((row) => ({
                    _id: row._id,
                    title: row.title ?? null,
                    started_at: row.started_at,
                    message_count: row.message_count,
                    is_private: row.is_private,
                    team_visibility: row.team_visibility ?? null,
                    auto_shared: false,
                    path: HEALTH,
                  })),
                  total: 2,
                  truncated: false,
                }
              : { rows: [], total: 0, truncated: false },
        );
        backend.mutation(api.pathStats.refreshPathStats, { queued: 0 });
        backend.mutation(users.updateSyncSettings, () => {
          if (!state.failNext) return member._id;
          state.failNext = false;
          return new Error("Server Error");
        });
        backend.mutation(users.updateDirectoryTeamMapping, undefined);
      },
    });
  return { appointment, load, lock, now, requests, state, syncViewer, team };
}

type Mount = Awaited<ReturnType<typeof mountWeb>>;
const writes = (root: Mount) =>
  root.backend.mutations.filter(
    ({ name }) => name !== "pathStats:refreshPathStats",
  );

test("a typed path stays private until it is shared, and a lock moves its row", async () => {
  const { appointment, load, lock, now, state, syncViewer, team } = fixtures();
  const root = await load(true);
  expect(text()).toMatch(/Nothing has synced yet, so nothing is shared/);
  expect(text()).toMatch(/add a folder above/);
  expect(text()).not.toMatch(/Start a coding session/);

  state.teams = [team];
  await act(async () => syncViewer(root.store.getState()));
  expect(text()).toMatch(/Nothing has synced yet, so nothing is shared/);
  expect(text()).not.toMatch(/Nothing shared with Union|teammates/);
  expect(byText("+ Add path")).toBeUndefined();
  const input = document.querySelector<HTMLInputElement>(
    'input[placeholder^="Full path of a folder"]',
  );
  expectPresent(input);
  expect(byText("Add")?.disabled).toBe(true);
  await changeInput(input, "   ");
  expect(byText("Add")?.disabled).toBe(true);
  await changeInput(input, "notes");
  expect(byText("Add")?.disabled).toBe(false);
  await click(byText("Add")!);
  expect(writes(root)).toEqual([]);
  await expectToast("error", "Type the full path");

  await changeInput(input, HEALTH + "/");
  state.failNext = true;
  await click(byText("Add")!);
  await expectToast("error", "Could not add health");
  expect(input.value).toBe(HEALTH + "/");
  await click(byText("Add")!);
  expect(writes(root).at(-1)).toEqual({
    name: "users:updateSyncSettings",
    args: { sync_projects: [HEALTH] },
  });
  await expectToast("success", "health added");

  state.user = { ...state.user, sync_projects: [HEALTH] };
  await act(async () => syncViewer(root.store.getState()));
  expect(text()).toMatch(/Private — only you/);
  expect(text()).toMatch(/no sessions yet/);
  const menu = byLabel("Who can open health");
  expectPresent(menu);
  expect(menu.textContent).toMatch(/Only me/);
  expect(text()).not.toMatch(/Never shared — locked/);

  expectAbsent(panel());
  await click(menu);
  expectPresent(panel());
  expect(chips().map((chip) => chip.textContent)).toEqual([
    "Only me",
    "Union",
    "Never share",
  ]);
  expect(chips()[0].getAttribute("aria-checked")).toBe("true");
  expect(apply().textContent).toBe("Close");
  await click(chips()[1]);
  expect(panelText()).toMatch(
    /Union \(2 teammates\) will see the whole conversation for health/,
  );
  expect(scopes()[0].checked).toBe(true);
  expect(panelText()).toMatch(/Appointment notes/);
  expect(panelText()).toMatch(/hidden by hand/);
  expect(apply().textContent).toBe("Share with Union");

  const session = (title: string) =>
    panel()?.querySelector<HTMLInputElement>(
      "[aria-label='Share \"" + title + "\"']",
    ) ?? null;
  expectPresent(session("Old scan"));
  const filter =
    panel()?.querySelector<HTMLInputElement>(
      '[aria-label="Filter sessions by title"]',
    ) ?? null;
  expectPresent(filter);
  await changeInput(filter, "appointment");
  expectAbsent(session("Old scan"));
  const shared = session("Appointment notes");
  expectPresent(shared);
  await click(shared);
  expect(panelText()).toMatch(/1 kept private/);
  await click(apply());
  expect(
    writes(root).find(({ name }) => name === "dispatch:dispatch"),
  ).toMatchObject({
    args: { action: "setPrivacy", args: [appointment._id, true] },
  });
  expect(
    writes(root).find(
      ({ name }) => name === "users:updateDirectoryTeamMapping",
    ),
  ).toEqual({
    name: "users:updateDirectoryTeamMapping",
    args: {
      path_prefix: HEALTH,
      team_id: team._id,
      auto_share: true,
      include_past: true,
      lock_private: [appointment._id],
    },
  });
  expectAbsent(panel());
  await expectToast("success", "health now shares with Union");

  state.mappings = [lock(HEALTH)];
  await act(async () => {
    root.backend.set(users.getDirectoryTeamMappings, state.mappings);
  });
  await act(async () => flushSyncPublishes());
  expect(text()).toMatch(/Never shared — locked by you/);
  expect(byLabel("Who can open health")?.textContent).toMatch(/Never shared/);
  expect(text()).not.toMatch(/Private — only you\s*1/);

  state.user = { ...state.user, sync_projects: [] };
  await act(async () => {
    syncViewer(root.store.getState());
    root.backend.set(users.getDirectoryTeamMappings, [
      lock("/Users/me/src/app", "acme/app"),
    ]);
    root.backend.set(users.getRecentProjectsWithGitInfo, ({ limit }) =>
      limit === 100
        ? [
            recentProject({
              path: CLONE,
              is_git_repo: true,
              session_count: 2,
              last_active: now,
              repository: "acme/app",
              private: true,
            }),
          ]
        : [],
    );
  });
  await act(async () => flushSyncPublishes());
  expect(text()).toMatch(/Never shared — locked by you/);
  const clone = buttons().find((b) =>
    (b.getAttribute("aria-label") ?? "").startsWith("Who can open app"),
  );
  expect(clone?.textContent).toMatch(/Never shared/);
  expect(clone?.textContent).toMatch(/\(repo\)/);
  expect(text()).toMatch(
    /Everything is private to you until you share a repository/,
  );
  await root.close();
});

test("sharing an unsynced folder counts local sessions and starts sync before sharing", async () => {
  const { load, now, state, team } = fixtures();
  state.user = { ...state.user, sync_mode: "selected" };
  state.teams = [team];
  state.local = [
    {
      path: SITE,
      repository: "me/site",
      sessions: 3,
      claude: 2,
      codex: 1,
      synced: 0,
      first: now - 10 * DAY,
      last: now - DAY,
      times: [now - DAY, now - 5 * DAY, now - 10 * DAY],
      git: true,
      exists: true,
    },
  ];
  const root = await load();
  expect(text()).toMatch(/Not syncing/);
  expect(text()).toMatch(/3 sessions on this machine · active/);
  expect(text()).toMatch(/not synced/);
  const site = byLabel("Who can open site");
  expectPresent(site);
  await click(site);
  await click(chips().find((chip) => chip.textContent === team.name)!);
  expect(panelText()).toMatch(/3 sessions, /);
  expect(panelText()).toMatch(
    /Sharing starts syncing this folder, past sessions included/,
  );
  const clock = spyOn(Date, "now").mockReturnValue(now);
  try {
    await click(scopes()[1]);
  } finally {
    clock.mockRestore();
  }
  expect(panelText()).toMatch(/The 3 sessions before that stay private/);
  await click(apply());
  const [startSync, share] = writes(root);
  expect(startSync).toEqual({
    name: "users:updateSyncSettings",
    args: { sync_mode: "selected", sync_projects: [SITE] },
  });
  expect(share).toEqual({
    name: "users:updateDirectoryTeamMapping",
    args: {
      path_prefix: SITE,
      team_id: team._id,
      auto_share: true,
      include_past: false,
      share_since: new Date(now).setHours(0, 0, 0, 0),
    },
  });
  expect(writes(root)).toHaveLength(2);
  await root.close();
});

test("a moved folder is listed separately below a live folder", async () => {
  const { load, now, requests, state, team } = fixtures();
  state.teams = [team];
  state.projects = [
    recentProject({
      path: OUTREACH,
      is_git_repo: false,
      session_count: 250,
      last_active: now - 200 * DAY,
    }),
    recentProject({
      path: LIVE,
      is_git_repo: true,
      session_count: 3,
      last_active: now,
    }),
  ];
  state.gone = [OUTREACH];
  const root = await load();
  expect(text()).toMatch(/No longer on this machine: moved or deleted/);
  expect(text()).toMatch(/Folder moved or deleted on this machine/);
  expectPresent(byLabel("Who can open live"));
  expect(text().indexOf("live")).toBeLessThan(
    text().indexOf("No longer on this machine"),
  );
  expect(
    requests
      .filter((url) => url.pathname === "/fs/exists")
      .at(-1)
      ?.searchParams.getAll("p")
      .sort(),
  ).toEqual([LIVE, OUTREACH].sort());
  await root.close();
});

test("sync all can exclude one folder, then turn it back on", async () => {
  const { load, now, state, team } = fixtures();
  state.teams = [team];
  state.projects = [
    recentProject({
      path: QUIET,
      is_git_repo: true,
      session_count: 0,
      last_active: now,
    }),
  ];
  const quiet = () =>
    document.querySelector<HTMLButtonElement>('[aria-label="Sync quiet"]');
  let root = await load();
  const enabled = quiet();
  expectPresent(enabled);
  await click(enabled);
  expect(writes(root)[0]).toEqual({
    name: "users:updateSyncSettings",
    args: { sync_excluded: [QUIET] },
  });
  await root.close();

  state.user = { ...state.user, sync_excluded: [QUIET] };
  root = await load();
  expect(text()).toMatch(/except the 1 you turned off below/);
  expect(text()).toMatch(/Not syncing/);
  await click(quiet()!);
  expect(writes(root)[0]).toEqual({
    name: "users:updateSyncSettings",
    args: { sync_excluded: [] },
  });
  await root.close();
});
