import {
  pushInboxViewHistory,
  sameInboxView,
  type InboxViewSnapshot,
} from "../../lib/inboxViewHistory";
import {
  sessionFocusKind,
  type SessionFocusKind,
} from "../../lib/inboxRouting";
import {
  DEFAULT_SETTINGS_SECTION,
  type SettingsSectionId,
} from "../../lib/settingsSections";
import type { TourRun } from "../../tours/types";
import type { SavedViewRow } from "../clientPrefsTypes";
import type { ComposeInstance } from "../composeSlice";
import { action } from "../mutativeMiddleware";
import {
  applyWorkbench as applyWorkbenchPure,
  captureWorkbench,
  chipFilterOf,
  resolveWorkbenchFilter,
  type WorkbenchSnapshot,
} from "../workbench";
import {
  autoAllowed as wsAutoAllowedPure,
  hidePane,
  hydrateWorkspace,
  isCommentRailOpen,
  isSessionRailOpen,
  SESSION_LIST_PANE,
  serializeWorkspace,
  setPresentation as wsSetPresentationPure,
  setSize as wsSetSizePure,
  showPane,
  TERMINAL_PANE,
  togglePane,
  type Pane,
  type PersistedWorkspace,
  type Presentation,
  type SlotId,
  type WorkspaceState,
} from "../workspace";

const CRITICAL_UI_KEYS = [
  "sidebar_collapsed",
  "zen_mode",
  "inbox_shortcuts_hidden",
  "inbox_flat_view",
  "workspace",
  "nav_sections",
] as const;
const CRITICAL_PREFS_LS_KEY = "codecast-critical-ui";
const DEVICE_WORKSPACE_KEY = "codecast-device-workspace";

export function readCriticalUiPrefs(): Record<string, any> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(CRITICAL_PREFS_LS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    const out: Record<string, any> = {};
    for (const k of CRITICAL_UI_KEYS) {
      if (parsed[k] !== undefined) out[k] = parsed[k];
    }
    return out;
  } catch {
    return {};
  }
}

export function writeCriticalUiPrefs(partial: Record<string, any>): void {
  if (typeof localStorage === "undefined") return;
  let toWrite: Record<string, any> | null = null;
  for (const k of CRITICAL_UI_KEYS) {
    if (Object.prototype.hasOwnProperty.call(partial, k)) {
      if (!toWrite) toWrite = {};
      toWrite[k] = partial[k];
    }
  }
  if (!toWrite) return;
  try {
    const existing = JSON.parse(
      localStorage.getItem(CRITICAL_PREFS_LS_KEY) || "{}",
    );
    localStorage.setItem(
      CRITICAL_PREFS_LS_KEY,
      JSON.stringify({ ...existing, ...toWrite }),
    );
  } catch {}
}

export function persistWorkspace(draft: any): void {
  if (
    typeof window !== "undefined" &&
    (window as any).__CODECAST_ELECTRON__?.isTabWindow === true
  )
    return;
  const ws = draft.workspace as WorkspaceState;
  if (!draft.clientState) draft.clientState = {};
  if (!draft.clientState.ui) draft.clientState.ui = {};
  draft.clientState.ui.workspace = serializeWorkspace(ws, "shared");
  writeCriticalUiPrefs({ workspace: draft.clientState.ui.workspace });
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(
        DEVICE_WORKSPACE_KEY,
        JSON.stringify(serializeWorkspace(ws, "device")),
      );
    }
  } catch {}
}

function readDeviceWorkspace(): any {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(DEVICE_WORKSPACE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export const selectNavCollapsed = (s: { workspace: WorkspaceState }) =>
  s.workspace.nav.presentation === "collapsed";

export const selectNavHidden = (s: {
  workspace: WorkspaceState;
  zenNavOpen: boolean;
  clientState: { ui?: { zen_mode?: boolean } | null };
}) => (s.clientState.ui?.zen_mode ? !s.zenNavOpen : selectNavCollapsed(s));

export const selectSessionRailOpen = (s: { workspace: WorkspaceState }) =>
  isSessionRailOpen(s.workspace);

export const selectCommentRailOpen = (s: { workspace: WorkspaceState }) =>
  isCommentRailOpen(s.workspace);

export const selectSessionRailUserClosed = (s: { workspace: WorkspaceState }) =>
  !wsAutoAllowedPure(s.workspace, "context", SESSION_LIST_PANE);

export type AnchorPanelTarget =
  | { kind: "anchor"; id: string }
  | { kind: "session"; id: string };

export type WorkspaceSliceState = {
  shortcutsPanelOpen: boolean;
  stagePick: { path: string; title?: string } | null;
  tour: TourRun | null;
  toursPanelOpen: boolean;
  anchorPanel: { open: boolean; target: AnchorPanelTarget | null };
  settingsModalSection: SettingsSectionId | null;
  peopleWallOpen: boolean;
  stageWide: { tabId: string; leafId: string | null } | null;
  profileSignIn: { deviceId: string; profile: string; start?: boolean } | null;
  workspace: WorkspaceState;
  activeWorkbenchId: string | null;
  zenNavOpen: boolean;
  sidePanelSessionId: string | null;
};

export type WorkspaceSliceActions = {
  toggleShortcutsPanel: () => void;
  setStagePick: (pick: { path: string; title?: string } | null) => void;
  setTour: (run: TourRun | null) => void;
  setToursPanelOpen: (open: boolean) => void;
  openAnchorPanel: (target?: AnchorPanelTarget | null) => void;
  closeAnchorPanel: () => void;
  toggleAnchorPanel: () => void;
  openSettingsModal: (section?: SettingsSectionId) => void;
  closeSettingsModal: () => void;
  setStageWide: (wide: { tabId: string; leafId: string | null } | null) => void;
  openProfileSignIn: (target: {
    deviceId: string;
    profile: string;
    start?: boolean;
  }) => void;
  closeProfileSignIn: () => void;
  closePeopleWall: () => void;
  togglePeopleWall: () => void;
  wsShow: (
    slot: SlotId,
    pane: Pane,
    opts?: { presentation?: Presentation },
  ) => void;
  wsHide: (slot: SlotId, opts?: { remember?: boolean }) => void;
  wsToggle: (slot: SlotId, pane: Pane) => void;
  wsSetPresentation: (slot: SlotId, presentation: Presentation) => void;
  applyWorkbench: (
    snap: WorkbenchSnapshot,
    id?: string,
    pathname?: string | null,
  ) => void;
  saveWorkbench: (name: string, path?: string) => any;
  updateWorkbench: (id: string, path?: string) => void;
  setNavCollapsed: (collapsed: boolean) => void;
  setZenNavOpen: (open: boolean) => void;
  setDockOpen: (open: boolean) => void;
  wsSetSize: (slot: SlotId, size: number) => void;
  openSidePanel: (sessionId: string) => void;
  closeSidePanel: () => void;
  clearSidePanelSession: () => void;
  toggleSidePanel: () => void;
  selectPanelSession: (sessionId: string | null) => void;
};

export type WorkspaceSlice = WorkspaceSliceState & WorkspaceSliceActions;

export type WorkspaceSliceDeps = {
  snapshotInboxViewFromDraft: (draft: any) => InboxViewSnapshot;
  evictFocusOutsideOrderInDraft: (
    draft: any,
    focusKind: SessionFocusKind,
  ) => void;
  recordSessionView: (draft: any, id: string, prevId?: string | null) => void;
};

type WorkspaceUiState = {
  zen_mode?: boolean;
  nav_sections?: Record<string, boolean>;
  workspace?: PersistedWorkspace;
};

type WorkspaceDraft = {
  workspace: WorkspaceState;
  activeWorkbenchId: string | null;
  zenNavOpen: boolean;
  sidePanelSessionId: string | null;
  currentSessionId: string | null;
  viewingDismissedId: string | null;
  currentConversation?: { source?: string } | null;
  clientState: { ui?: WorkspaceUiState };
  buckets: Record<string, { name: string }>;
  activeBucketFilter: string | null;
  extraBucketFilters: Array<{ id: string; exclude: boolean }>;
  extraProjectFilters: Array<{
    id: string;
    path: string | null;
    exclude: boolean;
  }>;
  activeProjectFilter: string | null;
  activeProjectPath: string | null;
  chipFilterExclude: boolean;
};

function initialWorkspace(): WorkspaceState {
  const prefs = readCriticalUiPrefs() as any;
  const device = readDeviceWorkspace();
  const ws = hydrateWorkspace(prefs.workspace, device);
  if (!device) {
    try {
      const raw =
        typeof localStorage !== "undefined"
          ? localStorage.getItem("cast_term_panel")
          : null;
      const legacy = raw ? JSON.parse(raw) : null;
      if (legacy?.open)
        ws.dock = {
          pane: { kind: "terminal" },
          presentation: "split",
          size: legacy.height,
        };
      else if (typeof legacy?.height === "number")
        ws.dock = { ...ws.dock, size: legacy.height };
    } catch {}
  }
  if (!prefs.workspace && prefs.sidebar_collapsed)
    ws.nav.presentation = "collapsed";
  return ws;
}

export function createWorkspaceSlice(
  set: any,
  get: any,
  deps: WorkspaceSliceDeps,
): WorkspaceSlice {
  return {
    shortcutsPanelOpen: false,
    toggleShortcutsPanel: () =>
      set({ shortcutsPanelOpen: !get().shortcutsPanelOpen }),
    stagePick: null,
    setStagePick: (pick: { path: string; title?: string } | null) =>
      set({ stagePick: pick }),
    tour: null,
    setTour: (run: TourRun | null) => set({ tour: run }),
    toursPanelOpen: false,
    setToursPanelOpen: (open: boolean) => set({ toursPanelOpen: open }),
    anchorPanel: { open: false, target: null },
    openAnchorPanel: (target?: AnchorPanelTarget | null) =>
      set({
        anchorPanel: {
          open: true,
          target: target === undefined ? get().anchorPanel.target : target,
        },
      }),
    closeAnchorPanel: () =>
      set({ anchorPanel: { ...get().anchorPanel, open: false } }),
    toggleAnchorPanel: () =>
      set({
        anchorPanel: { ...get().anchorPanel, open: !get().anchorPanel.open },
      }),

    settingsModalSection: null,
    openSettingsModal: (section?: SettingsSectionId) => {
      const modal = (get().composes as ComposeInstance[]).find(
        (c) => c.mode === "modal",
      );
      if (modal) {
        get().dockCompose(modal.id);
        get().setComposeCollapsed(modal.id, true);
      }
      set({ settingsModalSection: section ?? DEFAULT_SETTINGS_SECTION });
    },
    closeSettingsModal: () => set({ settingsModalSection: null }),

    peopleWallOpen: false,
    stageWide: null,
    setStageWide: (wide: { tabId: string; leafId: string | null } | null) =>
      set({ stageWide: wide }),
    profileSignIn: null,
    openProfileSignIn: (target: {
      deviceId: string;
      profile: string;
      start?: boolean;
    }) => set({ profileSignIn: target }),
    closeProfileSignIn: () => set({ profileSignIn: null }),
    closePeopleWall: () => set({ peopleWallOpen: false }),
    togglePeopleWall: () => set({ peopleWallOpen: !get().peopleWallOpen }),

    workspace: initialWorkspace(),

    wsShow: action(function (
      this: WorkspaceDraft,
      slot: SlotId,
      pane: Pane,
      opts?: { presentation?: Presentation },
    ) {
      this.workspace = showPane(
        this.workspace as WorkspaceState,
        slot,
        pane,
        opts,
      );
      persistWorkspace(this);
    }) as WorkspaceSliceActions["wsShow"],

    wsHide: action(function (
      this: WorkspaceDraft,
      slot: SlotId,
      opts?: { remember?: boolean },
    ) {
      this.workspace = hidePane(this.workspace as WorkspaceState, slot, opts);
      persistWorkspace(this);
    }) as WorkspaceSliceActions["wsHide"],

    wsToggle: action(function (this: WorkspaceDraft, slot: SlotId, pane: Pane) {
      this.workspace = togglePane(this.workspace as WorkspaceState, slot, pane);
      persistWorkspace(this);
    }) as WorkspaceSliceActions["wsToggle"],

    wsSetPresentation: action(function (
      this: WorkspaceDraft,
      slot: SlotId,
      presentation: Presentation,
    ) {
      this.workspace = wsSetPresentationPure(
        this.workspace as WorkspaceState,
        slot,
        presentation,
      );
      persistWorkspace(this);
    }) as WorkspaceSliceActions["wsSetPresentation"],

    setDockOpen: (open: boolean) => {
      const st = get();
      if (open) st.wsShow("dock", TERMINAL_PANE);
      else st.wsHide("dock", { remember: true });
    },

    zenNavOpen: false,
    setZenNavOpen: (open: boolean) => set({ zenNavOpen: open }),

    setNavCollapsed: action(function (
      this: WorkspaceDraft,
      collapsed: boolean,
    ) {
      this.workspace = wsSetPresentationPure(
        this.workspace as WorkspaceState,
        "nav",
        collapsed ? "collapsed" : "split",
      );
      persistWorkspace(this);
    }) as WorkspaceSliceActions["setNavCollapsed"],

    wsSetSize: action(function (
      this: WorkspaceDraft,
      slot: SlotId,
      size: number,
    ) {
      this.workspace = wsSetSizePure(
        this.workspace as WorkspaceState,
        slot,
        size,
      );
      persistWorkspace(this);
    }) as WorkspaceSliceActions["wsSetSize"],

    activeWorkbenchId: null,

    applyWorkbench: action(function (
      this: WorkspaceDraft,
      snap: WorkbenchSnapshot,
      id?: string,
      pathname?: string | null,
    ) {
      const conversationId =
        this.currentSessionId ?? this.viewingDismissedId ?? null;
      const allowTerminal =
        typeof window === "undefined" || window.innerWidth >= 768;
      this.workspace = applyWorkbenchPure(
        this.workspace as WorkspaceState,
        snap,
        { conversationId, allowTerminal },
      );
      this.activeWorkbenchId = id ?? null;
      persistWorkspace(this);
      const zen = snap.zen ?? false;
      if (!this.clientState.ui) this.clientState.ui = {};
      if ((this.clientState.ui.zen_mode ?? false) !== zen) {
        this.clientState.ui.zen_mode = zen;
        writeCriticalUiPrefs({ zen_mode: zen });
        this.zenNavOpen = false;
      }
      const sections = snap.navSections ?? {};
      if (
        JSON.stringify(this.clientState.ui.nav_sections ?? {}) !==
        JSON.stringify(sections)
      ) {
        this.clientState.ui.nav_sections = { ...sections };
        writeCriticalUiPrefs({
          nav_sections: this.clientState.ui.nav_sections,
        });
      }
      const prev = deps.snapshotInboxViewFromDraft(this);
      const want = resolveWorkbenchFilter(snap.filter, this.buckets);
      this.activeBucketFilter = want.bucket;
      this.extraBucketFilters = [];
      this.extraProjectFilters = [];
      this.activeProjectFilter = want.project;
      this.activeProjectPath = want.projectPath;
      this.chipFilterExclude = want.exclude;
      const next = deps.snapshotInboxViewFromDraft(this);
      if (sameInboxView(prev, next)) return;
      pushInboxViewHistory(prev, next);
      deps.evictFocusOutsideOrderInDraft(
        this,
        sessionFocusKind(pathname, this.currentConversation?.source),
      );
    }) as WorkspaceSliceActions["applyWorkbench"],

    saveWorkbench: (name: string, path?: string) => {
      const st = get();
      const snap = captureWorkbench(st.workspace as WorkspaceState, {
        zen: st.clientState.ui?.zen_mode ?? false,
        path,
        filter: chipFilterOf(st),
        navSections: st.clientState.ui?.nav_sections,
      });
      return st.createSavedView({ name, page: "workspace", prefs: snap });
    },

    updateWorkbench: (id: string, path?: string) => {
      const st = get();
      const prev = (st.savedViews as Record<string, SavedViewRow>)[id]
        ?.prefs as WorkbenchSnapshot | undefined;
      const snap = captureWorkbench(st.workspace as WorkspaceState, {
        zen: st.clientState.ui?.zen_mode ?? false,
        path: path ?? prev?.path,
        filter: chipFilterOf(st),
        navSections: st.clientState.ui?.nav_sections,
      });
      st.updateSavedView(id, { prefs: snap });
    },

    sidePanelSessionId: null,

    openSidePanel: action(function (this: WorkspaceDraft, sessionId: string) {
      this.sidePanelSessionId = sessionId;
      this.workspace = showPane(
        this.workspace as WorkspaceState,
        "context",
        SESSION_LIST_PANE,
      );
      persistWorkspace(this);
    }) as WorkspaceSliceActions["openSidePanel"],

    closeSidePanel: action(function (this: WorkspaceDraft) {
      this.sidePanelSessionId = null;
      this.workspace = hidePane(this.workspace as WorkspaceState, "context", {
        remember: true,
      });
      persistWorkspace(this);
    }) as WorkspaceSliceActions["closeSidePanel"],

    clearSidePanelSession: action(function (this: WorkspaceDraft) {
      this.sidePanelSessionId = null;
    }) as WorkspaceSliceActions["clearSidePanelSession"],

    toggleSidePanel: action(function (this: WorkspaceDraft) {
      const ws = this.workspace as WorkspaceState;
      if (isSessionRailOpen(ws)) {
        this.workspace = hidePane(ws, "context", { remember: true });
      } else {
        this.workspace = showPane(ws, "context", SESSION_LIST_PANE);
        this.sidePanelSessionId =
          this.sidePanelSessionId ?? this.currentSessionId ?? null;
      }
      persistWorkspace(this);
    }) as WorkspaceSliceActions["toggleSidePanel"],

    selectPanelSession: action(function (
      this: WorkspaceDraft,
      sessionId: string | null,
    ) {
      if (sessionId && sessionId === this.sidePanelSessionId) {
        this.sidePanelSessionId = null;
        return;
      }
      if (sessionId)
        deps.recordSessionView(this, sessionId, this.sidePanelSessionId);
      this.sidePanelSessionId = sessionId;
    }) as WorkspaceSliceActions["selectPanelSession"],
  };
}
