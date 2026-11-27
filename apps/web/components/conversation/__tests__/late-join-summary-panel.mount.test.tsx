import { afterEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import type { LateJoinSummary } from "../../../hooks/use-late-join-summary";
import { mountWeb } from "../../../test-helpers/mountWeb";
import { pending } from "../../../test-helpers/testConvex";
import { ConversationView } from "../../conversation-view";
import type { Message } from "../types";

const FLAG = "VITE_LATE_JOIN_SUMMARY";
const previousFlag = process.env[FLAG];

afterEach(() => {
  if (previousFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = previousFlag;
});

const conversationId = "j".repeat(32) as Id<"conversations">;
const userId = "u".repeat(32) as Id<"users">;
const anchorMsgId = "m".repeat(32) as Id<"messages">;
const latestMsgId = "n".repeat(32) as Id<"messages">;
const decisionId = "d".repeat(32) as Id<"session_decisions">;

const populatedSummary: LateJoinSummary = {
  anchor: {
    message_id: anchorMsgId,
    offset: 0.2,
    timestamp: 1_000,
    changed_at: 1_500,
  },
  new_turns: 3,
  turns_truncated: false,
  changed_files: [
    { path: "apps/web/components/conversation-view.tsx", count: 2 },
    { path: "apps/server/convex/lateJoinSummary.ts", count: 1 },
  ],
  changed_files_total: 2,
  decisions: [
    {
      _id: decisionId,
      short_id: "sd-42",
      title: "Keep summary behind flag?",
      state: "answered",
      answer: "Yes",
    },
  ],
  decisions_total: 1,
  open_prompt: {
    kind: "permission",
    label: "Run unit tests",
    tool_name: "Bash",
    created_at: 5_000,
  },
};

const emptySummary: LateJoinSummary = {
  anchor: populatedSummary.anchor,
  new_turns: 0,
  turns_truncated: false,
  changed_files: [],
  changed_files_total: 0,
  decisions: [],
  decisions_total: 0,
  open_prompt: null,
};

async function mountConversation({
  flag,
  summary,
  messages,
}: {
  flag: "1" | "0" | undefined;
  summary: LateJoinSummary | null;
  messages?: Message[];
}) {
  if (flag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = flag;

  const jump = mock((_timestamp: number) => {});
  const ui = await mountWeb(
    <ConversationView
      conversation={{
        _id: conversationId,
        user_id: userId,
        title: "Late join check",
        messages: messages ?? [
          {
            _id: latestMsgId,
            timestamp: 10_000,
            role: "user",
            content: "Latest message",
          } as Message,
        ],
      }}
      backHref="/"
      hideHeader
      showMessageInput={false}
      autoFocusInput={false}
      onJumpToTimestamp={jump}
    />,
    {
      authenticated: true,
      dispatch: true,
      setup(backend, store) {
        store.syncTable("currentUser", { _id: userId });
        for (const query of [
          api.transcripts.webCallsForConversation,
          api.devices.listDevices,
          api.sessionOwnership.listOwners,
          api.conversations.getUserMessages,
          api.commentTwins.conversationComments,
          api.pendingMessages.getConversationPendingMessage,
          api.messages.getConversationImages,
          api.conversationPages.list,
          api.tasks.webListByConversation,
          api.docSync.getPresence,
          api.sessionGoals.forConversation,
          api.guestSuggestions.listPending,
          api.quoteDrafts.listForConversation,
          api.externalEvents.listForConversation,
          api.workflows.webList,
          api.permissions.getPendingPermissions,
          api.commits.getCommitsForConversation,
          api.pull_requests.getPRsForConversation,
          api.pull_requests.sessionCardPRs,
          api.users.getMySkills,
          api.accountSwitch.listAccountProfiles,
        ])
          backend.set(query, pending);
        backend.mutation(api.users.requestTerminalEndpoints, {
          commands: [],
        });
        backend.set(api.lateJoinSummary.get, summary);
      },
    },
  );
  return { ...ui, jump };
}

test("absent when VITE_LATE_JOIN_SUMMARY flag is off", async () => {
  const ui = await mountConversation({
    flag: undefined,
    summary: populatedSummary,
  });
  expect(ui.container.querySelector("[data-cc-late-join-summary]")).toBeNull();
  expect(
    ui.backend.queryRequests.some((q) => q.name === "lateJoinSummary:get"),
  ).toBe(false);
  await ui.close();
});

test("absent when flag is on and there is nothing new", async () => {
  const ui = await mountConversation({
    flag: "1",
    summary: emptySummary,
  });
  expect(
    ui.backend.queryRequests.some((q) => q.name === "lateJoinSummary:get"),
  ).toBe(true);
  expect(ui.container.querySelector("[data-cc-late-join-summary]")).toBeNull();
  await ui.close();
});

test("shows summary, jumps to the read point, and hides on reaching the bottom", async () => {
  const ui = await mountConversation({
    flag: "1",
    summary: populatedSummary,
  });

  const panel = ui.container.querySelector("[data-cc-late-join-summary]");
  expect(panel).not.toBeNull();
  expect(panel?.textContent).toContain("3 turns");
  expect(panel?.textContent).toContain("2 files");
  expect(panel?.textContent).toContain("1 decision");
  expect(panel?.textContent).toContain("conversation-view.tsx");
  expect(panel?.textContent).toContain("lateJoinSummary.ts");
  expect(panel?.textContent).toContain("Keep summary behind flag?");
  expect(panel?.textContent).toContain("answered");
  expect(panel?.textContent).toContain("Run unit tests");

  const jumpBtn = ui.container.querySelector<HTMLButtonElement>(
    "[data-cc-late-join-jump]",
  );
  expect(jumpBtn).not.toBeNull();
  await act(async () => {
    jumpBtn!.click();
  });
  expect(ui.jump.mock.calls).toEqual([[populatedSummary.anchor.timestamp]]);

  const feed = ui.container.querySelector<HTMLElement>("[data-sv-feed]")!;
  let scrollTop = 0;
  Object.defineProperty(feed, "scrollHeight", {
    configurable: true,
    value: 1000,
  });
  Object.defineProperty(feed, "clientHeight", {
    configurable: true,
    value: 400,
  });
  Object.defineProperty(feed, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (v: number) => {
      scrollTop = v;
    },
  });

  await act(async () => {
    scrollTop = 100;
    feed.dispatchEvent(new Event("scroll"));
  });
  expect(
    ui.container.querySelector("[data-cc-late-join-summary]"),
  ).not.toBeNull();

  await act(async () => {
    scrollTop = 600;
    feed.dispatchEvent(new Event("scroll"));
  });
  expect(ui.container.querySelector("[data-cc-late-join-summary]")).toBeNull();

  await ui.close();
});
