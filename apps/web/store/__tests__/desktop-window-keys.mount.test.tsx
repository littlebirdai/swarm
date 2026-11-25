import { expect, test } from "bun:test";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { useConvex } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { act, type ReactNode } from "react";
import { AgentDock } from "../../components/agentDock/AgentDock";
import { Providers } from "../../src/providers";
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
import { DESKTOP_WINDOW_KEYS, desktopWindowKeys } from "../desktop-window-keys";
import {
  CLIENT_SYNC_REGISTRY,
  REPLICATED_STORE_KEYS,
} from "../clientSyncRegistry";
import { useInboxStore } from "../inboxStore";
import { observeDesktopStoreReads } from "../observe-desktop-store";
import { flushSyncPublishes } from "../syncTransaction";

const windows = {
  palette: () => import("../../app/palette/page"),
  people: () => import("../../app/people/page"),
  "call-panel": () => import("../../app/call-panel/page"),
  "agent-dock": () => import("../../app/agent-dock/page"),
  "call-ring": () => import("../../app/call-ring/page"),
  "meeting-offer": () => import("../../app/meeting-offer/page"),
  "share-cursors": () => import("../../app/share-cursors/page"),
} as const;

function PaletteAuth({ children }: { children: ReactNode }) {
  const client = useConvex();
  return (
    <ConvexAuthProvider client={client} storageNamespace="palette">
      {children}
    </ConvexAuthProvider>
  );
}

const roomKey = "room:test";
const docId = "d".repeat(32);
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
  "org:tree",
  "orgProposals:get",
  "replays:browse",
  "repos:listRepositories",
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
      const content = (
        <Providers>
          <Page />
          {kind === "agent-dock" && <AgentDock />}
        </Providers>
      );
      web = await mountWeb(
        kind === "palette" ? <PaletteAuth>{content}</PaletteAuth> : content,
        {
          authenticated: kind !== "palette",
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
            expect(desktopWindowKeys()).toBe(DESKTOP_WINDOW_KEYS[windowKind]);
            localStorage.setItem(AUTH_JWT_STORAGE_KEY, "fixture-jwt");
            useInboxStore.setState({
              clientStateInitialized: true,
              syncRole: "follower",
            });
            if (kind === "palette") {
              const claims = Buffer.from(
                JSON.stringify({
                  sub: "palette-viewer|test",
                  iat: 1,
                  exp: 3601,
                }),
              ).toString("base64url");
              localStorage.setItem(
                "__convexAuthJWT_palette",
                `eyJhbGciOiJIUzI1NiJ9.${claims}.test`,
              );
              useInboxStore.setState({
                currentUser: { _id: "palette-viewer" },
              });
            }
            const state = useInboxStore.getState();
            if (windowKind === "call-panel")
              useInboxStore.setState({
                call: { ...state.call, phase: "connected", roomKey },
              });
            if (kind === "call-panel") {
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
                }),
              ]);
            stop = observeDesktopStoreReads(keys, (key, caller) =>
              reads.set(key, caller),
            );
          },
        },
      );
      const checkReads = async (declared: readonly string[]) => {
        await act(async () => {
          flushSyncPublishes();
          useInboxStore.setState({});
        });
        expect(reads.has("clientState")).toBe(true);
        expect(
          [...reads]
            .filter(([key]) => !declared.includes(key))
            .map(([key, caller]) => `${key} via ${caller}`)
            .sort(),
        ).toEqual([]);
      };
      const declared = DESKTOP_WINDOW_KEYS[windowKind];
      await checkReads(declared);
      if (windowKind === "palette") {
        reads.clear();
        const window = web.dom.window;
        const input =
          window.document.querySelector<HTMLInputElement>("[cmdk-input]")!;
        expect(input).not.toBeNull();
        const setInputValue = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value",
        )?.set;
        await act(async () => {
          setInputValue?.call(input, "replays");
          input.dispatchEvent(new window.Event("input", { bubbles: true }));
        });
        expect(window.document.body.textContent).toContain("Ops: Replays");
        await checkReads(declared);
        expect(reads.has("opsReplayTallies")).toBe(true);
        expect(reads.has("repoBrowse")).toBe(true);
        reads.clear();
        await act(async () => {
          window.dispatchEvent(
            new window.CustomEvent("codecast-compose", { detail: "" }),
          );
        });
        expect(web.container.querySelector("textarea")).not.toBeNull();
        await checkReads(declared);
        for (const key of [
          "machineResources",
          "pendingMessageStatus",
          "reviewComments",
          "sessionCommands",
        ])
          expect(reads.has(key)).toBe(true);
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
        const objectId = "t".repeat(32);
        await act(async () => {
          if (!web) return;
          web.store.getState().dropRows("callStagePins", ["pin"]);
          web.store.getState().syncTable("callStagePins", [
            {
              _id: "object-pin",
              room_key: roomKey,
              ref: objectId,
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
          body.querySelector(`[data-stage-pin="${objectId}"]`),
        ).not.toBeNull();
        expect(
          body.querySelector('[aria-label="Close the thread"]'),
        ).not.toBeNull();
        await checkReads(declared);
        await act(async () => {
          const store = useInboxStore.getState();
          store.syncTable("orgProposals", [
            {
              _id: "proposal",
              short_id: "op-42",
              title: "Pinned proposal",
              author: { kind: "user", id: "u1", name: "Sam" },
            },
          ]);
          store.dropRows("callStagePins", ["object-pin"]);
          store.syncTable("callStagePins", [
            {
              _id: "proposal-pin",
              room_key: roomKey,
              ref: "op-42",
              kind: "object",
              title: "Pinned proposal",
              readable: true,
              at: 3,
            },
          ]);
        });
        expect(
          body.querySelector('[data-proposal-card="op-42"]'),
        ).not.toBeNull();
        await checkReads(declared);
        expect(reads.has("orgProposalChanges")).toBe(true);
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
      if (kind === "call-ring")
        expect(web.container.textContent).toContain("Fixture caller");
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
        expect(web.container.querySelector(".dock-card")).not.toBeNull();
      }
      await checkReads(declared);
      expect(badges.length > 0).toBe(
        declared.some((key) => key === "sessions"),
      );
      expect(web.navigationLog[0]?.path.split("?")[0]).toBe(`/${windowKind}`);
    } finally {
      stop?.();
      await web?.close();
      restoreWindowRole?.();
    }
  });
}
