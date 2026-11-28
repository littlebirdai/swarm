import { expect, mock, test } from "bun:test";
import { act } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import type { LateJoinSummary } from "../../../hooks/use-late-join-summary";
import { mountWeb } from "../../../test-helpers/mountWeb";
import { pending } from "../../../test-helpers/testConvex";
import { ConversationView } from "../../conversation-view";
import type { Message } from "../types";

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
  can_open_decisions: true,
  open_prompt: {
    kind: "permission",
    source: "pending_permission",
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
  can_open_decisions: true,
  open_prompt: null,
};

async function mountConversation({
  summary,
  convId = conversationId,
  messages,
  hasMoreBelow = false,
  onJumpToEnd,
}: {
  summary: LateJoinSummary | null;
  convId?: Id<"conversations">;
  messages?: Message[];
  hasMoreBelow?: boolean;
  onJumpToEnd?: () => void;
}) {
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
          api.conversationNav.getUserMessages,
          api.commentTwins.conversationComments,
          api.pendingMessages.getConversationPendingMessage,
          api.messages.getConversationImages,
          api.conversationPages.list,
          api.taskReads.webListByConversation,
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
          api.conversationReadAnchors.get,
        ])
          backend.set(query, pending);
        backend.mutation(api.users.requestTerminalEndpoints, {
          commands: [],
        });
        backend.mutation(api.dispatch.dispatch, () => null);
        backend.set(api.lateJoinSummary.get, summary);
      },
    },
  );
  return { ...ui, jump };
}

test("absent when there is nothing new", async () => {
  const ui = await mountConversation({
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

test("open prompt buttons and top prompt chip jump to an inline AskUserQuestion or docked permission card", async () => {
  const inlineSummary: LateJoinSummary = {
    ...populatedSummary,
    open_prompt: {
      kind: "question",
      source: "message",
      label: "Which target should ship first?",
      created_at: 8_000,
      message_id: questionMsgId,
      timestamp: 8_000,
    },
  };
  const inlineUi = await mountConversation({
    summary: inlineSummary,
  });

  const inlinePromptBtn = inlineUi.container.querySelector<HTMLButtonElement>(
    "[data-cc-late-join-prompt-jump]",
  );
  const inlineChipBtn = inlineUi.container.querySelector<HTMLButtonElement>(
    "[data-cc-late-join-prompt-badge]",
  );
  expect(inlinePromptBtn).not.toBeNull();
  expect(inlineChipBtn).not.toBeNull();
  await act(async () => {
    inlineChipBtn!.click();
  });
  await act(async () => {
    inlinePromptBtn!.click();
  });
  expect(inlineUi.jump.mock.calls).toEqual([[8_000], [8_000]]);
  await inlineUi.close();

  const jumpToEnd = mock(() => {});
  const dockUi = await mountConversation({
    summary: populatedSummary,
    hasMoreBelow: true,
    onJumpToEnd: jumpToEnd,
  });
  const dockChipBtn = dockUi.container.querySelector<HTMLButtonElement>(
    "[data-cc-late-join-prompt-badge]",
  );
  await act(async () => {
    dockChipBtn!.click();
  });
  expect(jumpToEnd).toHaveBeenCalledTimes(1);
  expect(
    dockUi.container.querySelector("[data-cc-late-join-summary]"),
  ).toBeNull();
  await dockUi.close();
});

test("clears pending_permission prompt on empty pendingPermissions without clearing fenced_turn permission", async () => {
  const ui = await mountConversation({
    summary: populatedSummary,
  });

  expect(
    ui.container.querySelector("[data-cc-late-join-prompt]"),
  ).not.toBeNull();
  await act(async () => {
    ui.backend.set(api.permissions.getPendingPermissions, [
      {
        _id: "perm-skip-1" as Id<"pending_permissions">,
        _creationTime: 10,
        conversation_id: conversationId,
        session_id: "sess-1",
        tool_name: "AskUserQuestion",
        arguments_preview: "{}",
        status: "pending",
        created_at: Date.now(),
      },
    ]);
  });
  expect(ui.container.querySelector("[data-cc-late-join-prompt]")).toBeNull();

  await act(async () => {
    ui.backend.set(api.lateJoinSummary.get, {
      ...populatedSummary,
      open_prompt: {
        kind: "permission",
        source: "fenced_turn",
        label: "Permission",
        created_at: 9_000,
      },
    });
  });
  await ui.rerender(
    <ConversationView
      conversation={{
        _id: otherConversationId,
        user_id: userId,
        title: "Fenced session",
        messages: [
          {
            _id: latestMsgId,
            timestamp: 10_000,
            role: "user",
            content: "Update",
          } as Message,
        ],
      }}
      backHref="/"
      hideHeader
      showMessageInput={false}
      autoFocusInput={false}
      onJumpToTimestamp={ui.jump}
    />,
  );
  await act(async () => {
    ui.backend.set(api.permissions.getPendingPermissions, []);
  });
  expect(
    ui.container.querySelector("[data-cc-late-join-prompt]"),
  ).not.toBeNull();
  await ui.close();
});

test("jumps locally to a loaded message folded in condensed density without remote timestamp jump", async () => {
  const jump = mock((_timestamp: number) => {});
  const ui = await mountWeb(
    <ConversationView
      conversation={{
        _id: conversationId,
        user_id: userId,
        title: "Condensed jump check",
        messages: [
          {
            _id: "u-start" as Id<"messages">,
            timestamp: 500,
            role: "user",
            content: "Start turn",
          } as Message,
          {
            _id: anchorMsgId,
            timestamp: 1_000,
            role: "assistant",
            content: "",
            tool_calls: [{ id: "tc-1", name: "Read", input: "{}" }],
          } as Message,
          {
            _id: latestMsgId,
            timestamp: 10_000,
            role: "assistant",
            content: "Done",
          } as Message,
        ],
      }}
      backHref="/"
      hideHeader
      initialDensity="condensed"
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
          api.conversationNav.getUserMessages,
          api.commentTwins.conversationComments,
          api.pendingMessages.getConversationPendingMessage,
          api.messages.getConversationImages,
          api.conversationPages.list,
          api.taskReads.webListByConversation,
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
          api.conversationReadAnchors.get,
        ])
          backend.set(query, pending);
        backend.mutation(api.users.requestTerminalEndpoints, {
          commands: [],
        });
        backend.mutation(api.dispatch.dispatch, () => null);
        backend.set(api.lateJoinSummary.get, populatedSummary);
      },
    },
  );

  const jumpBtn = ui.container.querySelector<HTMLButtonElement>(
    "[data-cc-late-join-jump]",
  );
  expect(jumpBtn).not.toBeNull();
  await act(async () => {
    jumpBtn!.click();
  });
  expect(jump).toHaveBeenCalledTimes(0);
  await ui.close();
});

test("omits /decisions links when can_open_decisions is false", async () => {
  const ui = await mountConversation({
    summary: { ...populatedSummary, can_open_decisions: false },
  });
  const panel = ui.container.querySelector("[data-cc-late-join-summary]");
  expect(panel?.textContent).toContain("Keep summary behind flag?");
  expect(panel?.querySelectorAll('a[href^="/decisions/"]')).toHaveLength(0);
  await ui.close();
});
