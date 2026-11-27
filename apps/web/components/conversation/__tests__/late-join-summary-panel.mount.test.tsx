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
const otherConversationId = "k".repeat(32) as Id<"conversations">;
const userId = "u".repeat(32) as Id<"users">;
const anchorMsgId = "m".repeat(32) as Id<"messages">;
const latestMsgId = "n".repeat(32) as Id<"messages">;
const questionMsgId = "q".repeat(32) as Id<"messages">;
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
  changed_files_truncated: false,
  decisions: [
    {
      _id: decisionId,
      short_id: "sd-42",
      title: "Keep summary behind flag?",
      state: "pending",
    },
  ],
  decisions_total: 1,
  decisions_truncated: false,
  open_prompt: {
    kind: "permission",
    label: "Run unit tests",
    tool_name: "Bash",
    created_at: 5_000,
  },
};

const truncatedSummary: LateJoinSummary = {
  ...populatedSummary,
  new_turns: 200,
  turns_truncated: true,
  changed_files_total: 25,
  changed_files_truncated: true,
  decisions_total: 10,
  decisions_truncated: true,
};

const emptySummary: LateJoinSummary = {
  anchor: populatedSummary.anchor,
  new_turns: 0,
  turns_truncated: false,
  changed_files: [],
  changed_files_total: 0,
  changed_files_truncated: false,
  decisions: [],
  decisions_total: 0,
  decisions_truncated: false,
  open_prompt: null,
};

async function mountConversation({
  flag,
  summary,
  convId = conversationId,
  messages,
  hasMoreBelow = false,
  onJumpToEnd,
}: {
  flag: "1" | "0" | undefined;
  summary: LateJoinSummary | null;
  convId?: Id<"conversations">;
  messages?: Message[];
  hasMoreBelow?: boolean;
  onJumpToEnd?: () => void;
}) {
  if (flag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = flag;

  const jump = mock((_timestamp: number) => {});
  const ui = await mountWeb(
    <ConversationView
      conversation={{
        _id: convId,
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
      hasMoreBelow={hasMoreBelow}
      onJumpToTimestamp={jump}
      onJumpToEnd={onJumpToEnd}
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
    ui.backend.queryRequests.filter((q) => q.name === "lateJoinSummary:get"),
  ).toHaveLength(1);
  expect(ui.container.querySelector("[data-cc-late-join-summary]")).toBeNull();
  await ui.close();
});

test("queries once per conversation visit, renders truncated counts, links decisions, jumps to prompt, and hides at bottom", async () => {
  const jumpToEnd = mock(() => {});
  const ui = await mountConversation({
    flag: "1",
    summary: truncatedSummary,
    hasMoreBelow: true,
    onJumpToEnd: jumpToEnd,
  });

  const panel = ui.container.querySelector("[data-cc-late-join-summary]");
  expect(panel).not.toBeNull();
  expect(panel?.textContent).toContain("200+ turns");
  expect(panel?.textContent).toContain("25+ files");
  expect(panel?.textContent).toContain("10+ decisions");
  expect(panel?.textContent).toContain("Keep summary behind flag?");
  expect(panel?.textContent).toContain("Run unit tests");

  expect(
    ui.backend.queryRequests.filter((q) => q.name === "lateJoinSummary:get"),
  ).toHaveLength(1);

  await ui.rerender(
    <ConversationView
      conversation={{
        _id: conversationId,
        user_id: userId,
        title: "Late join check",
        messages: [
          {
            _id: latestMsgId,
            timestamp: 10_000,
            role: "user",
            content: "Latest message",
          } as Message,
          {
            _id: questionMsgId,
            timestamp: 12_000,
            role: "assistant",
            content: "Streamed update",
          } as Message,
        ],
      }}
      backHref="/"
      hideHeader
      showMessageInput={false}
      autoFocusInput={false}
      hasMoreBelow
      onJumpToTimestamp={ui.jump}
      onJumpToEnd={jumpToEnd}
    />,
  );
  expect(
    ui.backend.queryRequests.filter((q) => q.name === "lateJoinSummary:get"),
  ).toHaveLength(1);

  await act(async () => {
    ui.backend.set(api.lateJoinSummary.get, emptySummary);
  });
  expect(
    ui.container.querySelector("[data-cc-late-join-summary]"),
  ).not.toBeNull();

  ui.backend.set(api.lateJoinSummary.get, truncatedSummary);

  const decisionLink = ui.container.querySelector<HTMLAnchorElement>(
    `[data-cc-late-join-decision="${decisionId}"]`,
  );
  expect(decisionLink?.getAttribute("href")).toBe("/decisions/sd-42");

  const jumpBtn = ui.container.querySelector<HTMLButtonElement>(
    "[data-cc-late-join-jump]",
  );
  await act(async () => {
    jumpBtn!.click();
  });
  expect(ui.jump.mock.calls).toEqual([[truncatedSummary.anchor.timestamp]]);

  const paginatedEndBtn = ui.container.querySelector<HTMLButtonElement>(
    'button[aria-label="Scroll to bottom"]',
  );
  expect(paginatedEndBtn).not.toBeNull();
  await act(async () => {
    paginatedEndBtn!.click();
  });
  expect(jumpToEnd).toHaveBeenCalledTimes(1);
  expect(ui.container.querySelector("[data-cc-late-join-summary]")).toBeNull();

  await ui.rerender(
    <ConversationView
      conversation={{
        _id: otherConversationId,
        user_id: userId,
        title: "Next session",
        messages: [
          {
            _id: latestMsgId,
            timestamp: 10_000,
            role: "user",
            content: "Other message",
          } as Message,
        ],
      }}
      backHref="/"
      hideHeader
      showMessageInput={false}
      autoFocusInput={false}
      onJumpToTimestamp={ui.jump}
      onJumpToEnd={jumpToEnd}
    />,
  );
  expect(
    ui.backend.queryRequests.filter((q) => q.name === "lateJoinSummary:get"),
  ).toHaveLength(2);
  expect(
    ui.container.querySelector("[data-cc-late-join-summary]"),
  ).not.toBeNull();

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

  await act(async () => {
    ui.store.getState().syncRecord("sessionReadAnchors", otherConversationId, {
      _id: otherConversationId,
      user_id: userId,
      message_id: anchorMsgId,
      offset: 0.5,
      changed_at: 99_999,
      timestamp: 1_000,
    });
  });
  expect(ui.container.querySelector("[data-cc-late-join-summary]")).toBeNull();

  await ui.close();
});

test("open prompt button jumps to an inline AskUserQuestion or docked permission card", async () => {
  const inlineSummary: LateJoinSummary = {
    ...populatedSummary,
    open_prompt: {
      kind: "question",
      label: "Which target should ship first?",
      created_at: 8_000,
      message_id: questionMsgId,
      timestamp: 8_000,
    },
  };
  const inlineUi = await mountConversation({
    flag: "1",
    summary: inlineSummary,
  });

  const inlinePromptBtn = inlineUi.container.querySelector<HTMLButtonElement>(
    "[data-cc-late-join-prompt-jump]",
  );
  expect(inlinePromptBtn).not.toBeNull();
  await act(async () => {
    inlinePromptBtn!.click();
  });
  expect(inlineUi.jump.mock.calls).toEqual([[8_000]]);
  await inlineUi.close();

  const jumpToEnd = mock(() => {});
  const dockUi = await mountConversation({
    flag: "1",
    summary: populatedSummary,
    hasMoreBelow: true,
    onJumpToEnd: jumpToEnd,
  });
  const dockPromptBtn = dockUi.container.querySelector<HTMLButtonElement>(
    "[data-cc-late-join-prompt-jump]",
  );
  await act(async () => {
    dockPromptBtn!.click();
  });
  expect(jumpToEnd).toHaveBeenCalledTimes(1);
  expect(
    dockUi.container.querySelector("[data-cc-late-join-summary]"),
  ).toBeNull();
  await dockUi.close();
});
