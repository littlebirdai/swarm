import { expect, test } from "bun:test";
import { makeFunctionReference } from "convex/server";
import { act } from "react";
import { AgentDock } from "../../components/agentDock/AgentDock";
import { Providers } from "../../src/providers";
import { readJoinPrefs } from "../../lib/calls/joinPrefs";
import { requestCallThread } from "../../lib/calls/callStage";
import {
  getDesktopWindowRole,
  type DesktopWindowRole,
} from "../../lib/desktop";
import type { MeetingOffer } from "../../lib/desktopMeetings";
import { session } from "./bucketFixtures";
import { AUTH_JWT_STORAGE_KEY } from "../../lib/localAuth";
import { mountWeb } from "../../test-helpers/mountWeb";
import { pending } from "../../test-helpers/testConvex";
import { waitForDom } from "../../test-helpers/waitForDom";
import { desktopWindowKeys } from "../desktop-window-keys";
import {
  CLIENT_SYNC_REGISTRY,
  REPLICATED_STORE_KEYS,
} from "../clientSyncRegistry";
import { useInboxStore } from "../inboxStore";
import { observeDesktopStoreReads } from "../observe-desktop-store";
import { flushSyncPublishes, syncTransaction } from "../syncTransaction";

const windows = {
  palette: () => import("../../app/palette/page"),
  people: () => import("../../app/people/page"),
  "call-panel": () => import("../../app/call-panel/page"),
  "agent-dock": () => import("../../app/agent-dock/page"),
  "call-ring": () => import("../../app/call-ring/page"),
  "meeting-offer": () => import("../../app/meeting-offer/page"),
  "share-cursors": () => import("../../app/share-cursors/page"),
} as const;

const roomKey = "room:test";
const docId = "d".repeat(32);
const taskId = "t".repeat(32);
const pinRef = `doc:${docId}`;
const notifications = makeFunctionReference<"query">("notifications:list");
const queries = [
  "callRecordings:getRoomRecordingEnd",
  "entities:resolveIdType",
  "tasks:webGet",
  "taskMining:webGetDocDetail",
  "transcripts:getLive",
  "callChat:list",
  "callGuests:listGuestLinks",
  "callStage:listPins",
  "org:roles",
  "replays:browse",
  "liveArtifacts:elementsSince",
  "liveArtifacts:versions",
  "livePresence:presence",
  "users:getMySkills",
  "devices:listDevices",
  "users:getRecentProjectPaths",
  "teamHosts:list",
  "agentTasks:webList",
  "assistant/incidents:thinkingAvailable",
  "bookmarks:listBookmarks",
  "calls:getCallConfig",
  "client_state:get",
  "conversations:listFavoriteSessions",
  "conversations:listInboxSessions",
  "conversations:listRecentSessions",
  "conversations:sessionsLiveness",
  "docs:webMentionList",
  "teams:getUserTeams",
  "users:getCurrentUser",
];

for (const kind of [...Object.keys(windows), "voice-host"] as (
  | keyof typeof windows
  | "voice-host"
)[]) {
  const windowKind = kind === "voice-host" ? "call-panel" : kind;
  test(`${kind} store reads`, async () => {
    const Page = (await windows[windowKind]()).default;
    const reads = new Map<string, string>();
    let offer: ((meeting: MeetingOffer) => void) | undefined;
    let restoreWindowRole: (() => void) | undefined;
    const badges: number[] = [];
    const banners: string[] = [];
    const keys = new Set<string>([
      ...Object.keys(CLIENT_SYNC_REGISTRY),
      ...REPLICATED_STORE_KEYS,
    ]);
    let stop: (() => void) | undefined;
    let web: Awaited<ReturnType<typeof mountWeb>> | undefined;
    try {
      web = await mountWeb(
        <Providers>
          <Page />
          {kind === "agent-dock" && <AgentDock />}
        </Providers>,
        {
          authenticated: true,
          dispatch: true,
          path:
            kind === "call-panel"
              ? `/call-panel?room=${roomKey}&ring=1`
              : `/${windowKind}`,
          setup(backend) {
            backend.mutation(
              makeFunctionReference<"mutation">("dispatch:dispatch"),
              undefined,
            );
            backend.mutation(
              makeFunctionReference<"mutation">("pushRouter:reportPresence"),
              undefined,
            );
            backend.mutation(
              makeFunctionReference<"mutation">(
                "users:requestTerminalEndpoints",
              ),
              undefined,
            );
            for (const mutation of [
              "livePresence:setPresence",
              "livePresence:leave",
            ])
              backend.mutation(
                makeFunctionReference<"mutation">(mutation),
                undefined,
              );
            for (const query of queries)
              backend.set(makeFunctionReference<"query">(query), pending);
            backend.set(notifications, []);
            Object.defineProperty(window, "__CODECAST_ELECTRON__", {
              value: {
                isCallPanelWindow: windowKind === "call-panel",
                onWindowRole: (
                  callback: (role: Partial<DesktopWindowRole>) => void,
                ) => {
                  const previousRole = getDesktopWindowRole();
                  restoreWindowRole = () => callback(previousRole);
                  callback({ facesOverlay: kind === "voice-host" });
                },
                ...(kind === "voice-host" ? { voiceHostReady() {} } : {}),
                onMeetingDetected: (callback: typeof offer) => {
                  offer = callback;
                },
                setBadgeCount: (count: number) => badges.push(count),
                showNotification: (title: string) => {
                  banners.push(title);
                  return { shown: true };
                },
              },
            });
            const scope = desktopWindowKeys();
            expect(scope !== undefined).toBe(
              ["call-ring", "meeting-offer", "share-cursors"].includes(
                windowKind,
              ),
            );
            localStorage.setItem(AUTH_JWT_STORAGE_KEY, "fixture-jwt");
            useInboxStore.setState({
              clientStateInitialized: true,
              syncRole: "follower",
            });
            const state = useInboxStore.getState();
            if (windowKind === "call-panel")
              useInboxStore.setState({
                call: { ...state.call, phase: "connected", roomKey },
              });
            if (kind === "palette") {
              state.syncTable("docs", [
                { _id: docId, title: "Recent fixture doc" },
              ]);
              state.syncTable("pullRequests", [
                {
                  _id: "pr-fixture",
                  number: 123,
                  repository: "fixture/project",
                  title: "Fixture PR",
                },
              ]);
              state.syncTable("commits", [
                {
                  _id: "commit-fixture",
                  sha: "abcdef1234567",
                  message: "Fixture commit",
                },
              ]);
              const path = `/docs/${docId}`;
              useInboxStore.setState({
                recentVisits: [
                  { kind: "page", key: `page:${path}`, path, ts: Date.now() },
                ],
              });
            }
            if (kind === "call-panel") {
              backend.set(makeFunctionReference<"query">("callChat:list"), [
                {
                  _id: "room-message",
                  user_id: "user",
                  user_name: "Test user",
                  at: Date.now(),
                  text: "Fixture room message",
                  mine: false,
                  agent: null,
                },
              ]);
              state.syncTable("tasks", [
                { _id: taskId, title: "Task from the store" },
              ]);
              state.syncTable("callStagePins", [
                {
                  _id: "pin",
                  room_key: roomKey,
                  ref: pinRef,
                  kind: "doc",
                  doc_id: docId,
                  title: "Pinned fixture",
                  readable: true,
                  at: 1,
                },
              ]);
              requestCallThread();
            }
            if (kind === "call-ring")
              useInboxStore.setState({
                myCalls: {
                  incoming: [
                    {
                      _id: "ring",
                      room_key: roomKey,
                      from_name: "Fixture caller",
                    },
                  ],
                  outgoing: [],
                  membership: null,
                },
              });
            if (kind === "agent-dock")
              state.syncTable("sessions", [
                session("dock-session", {
                  title: "Fixture dock card",
                  is_idle: false,
                  idle_summary: "Read ct-42",
                  standing_role_id: "role",
                }),
              ]);
            if (kind === "agent-dock")
              state.syncTable("tasks", [
                {
                  _id: taskId,
                  short_id: "ct-42",
                  title: "Dock task from the store",
                },
              ]);
            if (scope)
              stop = observeDesktopStoreReads(keys, (key, caller) =>
                reads.set(key, caller),
              );
          },
        },
      );
      if (windowKind === "palette") {
        const window = web.dom.window;
        const input =
          window.document.querySelector<HTMLInputElement>("[cmdk-input]")!;
        expect(input).not.toBeNull();
        const setInputValue = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value",
        )?.set;
        expect(window.document.body.textContent).toContain(
          "Recent fixture doc",
        );
        for (const [query, result] of [
          ["replays", "Ops: Replays"],
          ["pr:", "fixture/project#123"],
          ["commit:", "abcdef1"],
        ]) {
          await act(async () => {
            setInputValue?.call(input, query);
            input.dispatchEvent(new window.Event("input", { bubbles: true }));
          });
          expect(window.document.body.textContent).toContain(result);
        }
        await act(async () => {
          window.dispatchEvent(
            new window.CustomEvent("codecast-compose", { detail: "" }),
          );
        });
        const composer = web.container.querySelector("textarea")!;
        expect(composer).not.toBeNull();
        await act(async () => {
          Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype,
            "value",
          )?.set?.call(composer, "@");
          composer.setSelectionRange(1, 1);
          composer.dispatchEvent(new window.Event("input", { bubbles: true }));
        });
        const mention = `[data-mention-id="${docId}"]`;
        await waitForDom(
          window.document.body,
          () => !!window.document.body.querySelector(mention),
        );
        expect(
          window.document.body.querySelector(mention)?.textContent,
        ).toContain("Recent fixture doc");
      }
      if (kind === "call-panel") {
        const body = web.dom.window.document.body;
        const pin = body.querySelector<HTMLButtonElement>(
          'button[aria-label="Pin to the stage"]',
        );
        expect(pin).not.toBeNull();
        await act(async () => pin?.click());
        expect(
          body.querySelector('[role="dialog"][aria-label="Pin to the stage"]'),
        ).not.toBeNull();
        expect(
          body.querySelector(`[data-stage-pin="${pinRef}"]`),
        ).not.toBeNull();
        await act(async () => {
          if (!web) return;
          web.store.getState().dropRows("callStagePins", ["pin"]);
          web.store.getState().syncTable("callStagePins", [
            {
              _id: "object-pin",
              room_key: roomKey,
              ref: taskId,
              kind: "object",
              title: "Pinned task",
              readable: true,
              at: 2,
            },
          ]);
          web.store.getState().openPalette();
        });
        await waitForDom(
          body,
          () => !!body.querySelector('[aria-label="Command menu"]'),
        );
        expect(
          body.querySelector(`[data-stage-pin="${taskId}"]`),
        ).not.toBeNull();
        expect(
          body.querySelector('[aria-label="Close the thread"]'),
        ).not.toBeNull();
        expect(body.textContent).toContain("Fixture room message");
        expect(body.textContent).toContain("Task from the store");
        for (const [previous, type] of [
          ["object-pin", "board"],
          ["board", "dashboard"],
        ]) {
          await act(async () => {
            const store = useInboxStore.getState();
            store.dropRows("callStagePins", [previous]);
            store.syncTable("callStagePins", [
              {
                _id: type,
                room_key: roomKey,
                ref: pinRef,
                kind: "doc",
                doc_id: docId,
                doc_type: type,
                title: `Pinned ${type}`,
                readable: true,
                at: 4,
              },
            ]);
          });
          expect(
            body.querySelector(`[data-live-embed="${type}"]`),
          ).not.toBeNull();
        }
      }
      if (kind === "voice-host")
        expect(
          web.dom.window.document.querySelector(".voice-float-window"),
        ).not.toBeNull();
      if (kind === "people") {
        const msgId = "m".repeat(32);
        const channelId = "c".repeat(32);
        useInboxStore
          .getState()
          .syncTable("chatMessages", [{ _id: msgId, channel_id: channelId }]);
        await act(async () =>
          web?.backend.set(notifications, [
            {
              _id: "notification",
              created_at: Date.now(),
              type: "chat_mention",
              entity_type: "chat_channel",
              entity_id: channelId,
              chat_message_id: msgId,
              message: "Fixture chat banner",
              read: false,
            },
          ]),
        );
        expect(banners.length).toBe(1);
      }
      if (kind === "call-ring") {
        expect(web.container.textContent).toContain("Fixture caller");
        syncTransaction(() => {
          useInboxStore.setState({
            clientState: { ui: { call_device_check: false } },
          });
          reads.delete("clientState");
          expect(readJoinPrefs().deviceCheck).toBe(false);
          expect(reads.get("clientState")).toContain("calls/joinPrefs.ts");
        });
      }
      if (kind === "meeting-offer") {
        await act(async () =>
          offer?.({
            app: "zoom",
            name: "Fixture meeting",
            decision: "ask",
            at: Date.now(),
          }),
        );
        expect(web.container.textContent).toContain("Fixture meeting");
      }
      if (kind === "agent-dock") {
        const card = web.container.querySelector<HTMLButtonElement>(
          '[title="Fixture dock card"]',
        );
        expect(card).not.toBeNull();
        await act(async () => card?.click());
        const dock = web.container.querySelector(".dock-card");
        expect(dock?.textContent).toContain("Dock task from the store");
      }
      const declared = desktopWindowKeys();
      if (declared) {
        await act(async () => flushSyncPublishes());
        expect(reads.has("clientState")).toBe(true);
        expect(
          [...reads]
            .filter(
              ([key]) => !declared.includes(key as (typeof declared)[number]),
            )
            .map(([key, caller]) => `${key} via ${caller}`)
            .sort(),
        ).toEqual([]);
      }
      expect(badges.length > 0).toBe(declared === undefined);
      expect(web.navigationLog[0]?.path.split("?")[0]).toBe(`/${windowKind}`);
    } finally {
      stop?.();
      await web?.close();
      restoreWindowRole?.();
    }
  });
}
