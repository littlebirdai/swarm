import { expect, mock, test } from "bun:test";
import { act, useLayoutEffect } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import type { FunctionArgs } from "convex/server";
import { ConversationView } from "../../components/conversation-view";
import {
  useSavedReadingAnchor,
  type SavedReadingAnchor,
} from "../use-saved-reading-anchor";
import { replaceGlobals } from "../../test-helpers/globals";
import { mountWeb } from "../../test-helpers/mountWeb";
import { pending } from "../../test-helpers/testConvex";
import { makeDispatchBinding } from "../../lib/dispatch-binding";
import { noteInputForTests, TYPING_QUIET_MS } from "../../lib/inputQuiet";
import {
  readingRowForMessage,
  restoreReadingPosition,
  watchReadingScroll,
} from "../../components/conversation/reading-viewport";
import type {
  Message,
  TimelineItem,
} from "../../components/conversation/types";
import {
  DATA_SCOPE,
  REPLICATION_CLASSIFICATION,
  isPersistedClientStoreKey,
} from "../../store/clientSyncRegistry";

const anchors = api.conversationReadAnchors;
type DispatchArgs = FunctionArgs<typeof api.dispatch.dispatch>;
const dispatches = (backend: Awaited<ReturnType<typeof mountWeb>>["backend"]) =>
  backend.mutations.flatMap((event) =>
    event.name === "dispatch:dispatch" ? [event.args as DispatchArgs] : [],
  );
const viewId = "00000000-0000-4000-8000-000000000001";
const conversation = "j".repeat(32) as Id<"conversations">;
const user = "u".repeat(32) as Id<"users">;
const first = "m".repeat(32) as Id<"messages">;
const second = "n".repeat(32) as Id<"messages">;
const checkpoint: SavedReadingAnchor = {
  _id: conversation,
  user_id: user,
  message_id: first,
  offset: 0.3,
  changed_at: 1,
  timestamp: 2,
};

async function open({
  answer = null,
  restoreResult = "restored",
  lostExit = false,
  wireLate = false,
  beginReply,
  beginError = false,
}: {
  answer?: SavedReadingAnchor | typeof pending | null;
  restoreResult?: "restored" | "loading" | "requested";
  lostExit?: boolean;
  wireLate?: boolean;
  beginReply?: () => string | Error | Promise<string>;
  beginError?: boolean;
} = {}) {
  const restore = mock(
    (
      _anchor: SavedReadingAnchor,
      _requestedWindow: boolean,
      _expired: boolean,
      _windowLoaded: boolean,
    ) => restoreResult,
  );
  type Observe = ReturnType<typeof useSavedReadingAnchor>;
  let observe: Observe;
  let saved = answer === pending ? null : answer;
  let saves = 0;

  function View({ viewer = user }: { viewer?: Id<"users"> }) {
    const measure = useSavedReadingAnchor({
      conversationId: conversation,
      userId: viewer,
      restore,
    });
    useLayoutEffect(() => {
      observe = measure;
    }, [measure]);
    return null;
  }
  const ui = await mountWeb(<View />, {
    authenticated: true,
    clock: true,
    dispatch: true,
    expectedConsoleErrors:
      lostExit || beginError
        ? [/CONVEX M\(dispatch:dispatch\).*Disconnected/]
        : [],
    setup(backend, store) {
      if (wireLate) store._setDispatch(null);
      document.hasFocus = () => true;
      backend.set(anchors.get, answer);
      backend.mutation(api.dispatch.dispatch, ({ action, args: [args] }) => {
        if (action === "beginSavedReadingAnchor")
          return beginReply?.() ?? viewId;
        if (action !== "saveSavedReadingAnchor") throw new Error(action);
        saves++;
        if (lostExit && saves > 1) return new Error("Uncaught Disconnected");
        saved = {
          ...checkpoint,
          message_id: args.message_id,
          offset: args.offset,
        };
        return "saved";
      });
    },
  });
  const sample = (id: string, offset: number, scrolled = true) =>
    act(() => observe?.(id, offset, scrolled));
  const writes = () =>
    dispatches(ui.backend).flatMap((event) =>
      event.action === "saveSavedReadingAnchor"
        ? [{ args: event.args[0] }]
        : [],
    );
  return { ...ui, sample, writes, restore, View, saved: () => saved };
}

test("solo capture checkpoints at most twice per viewer-minute and saves the final position on clean exit", async () => {
  const ui = await open();
  await ui.sample(first, 0, false);
  for (let heartbeat = 0; heartbeat < 20; heartbeat++) {
    await ui.sample(first, 0, false);
    ui.backend.ping();
    await ui.clock!.advance(3000);
  }
  expect(ui.writes()).toEqual([]);
  expect(ui.backend.mutations).toHaveLength(1);
  for (let tick = 1; tick <= 60; tick++) {
    await ui.sample(
      second,
      tick <= 30 ? tick / 60 : 0.6 + (tick - 31) * (0.4 / 29),
    );
    ui.backend.ping();
    await ui.clock!.advance(1000);
  }
  expect(ui.writes().map((w) => w.args)).toEqual([
    {
      conversation_id: conversation,
      message_id: second,
      offset: 0.5,
      sequence: 1,
      view_id: viewId,
    },
    {
      conversation_id: conversation,
      message_id: second,
      offset: 1,
      sequence: 2,
      view_id: viewId,
    },
  ]);
  await ui.sample(second, 0.98);
  await ui.close();
  expect(ui.writes().at(-1)?.args).toMatchObject({
    message_id: second,
    offset: 0.98,
    sequence: 3,
    view_id: viewId,
  });
  expect(ui.restore).not.toHaveBeenCalled();
  expect(ui.store.getState().sessionReadAnchors).toEqual({});
});

test("after a lost final save a reconnect restores the checkpoint once, through the local store", async () => {
  const ui = await open({ answer: checkpoint, lostExit: true });
  expect(ui.restore).toHaveBeenCalledTimes(1);
  expect(ui.restore).toHaveBeenCalledWith(checkpoint, false, false, false);
  expect(ui.store.getState().sessionReadAnchors[conversation]).toEqual(
    checkpoint,
  );
  await ui.sample(first, 0.3, false);
  await ui.sample(second, 0.6);
  await ui.clock!.advance(30_000);
  await ui.sample(first, 0.8);
  await ui.close();
  expect(ui.writes()).toHaveLength(2);
  expect(ui.saved()).toMatchObject({ message_id: second, offset: 0.6 });

  const again = await open({ answer: ui.saved() });
  expect(again.restore).toHaveBeenCalledTimes(1);
  expect(again.restore.mock.calls[0]?.[0]).toMatchObject({
    message_id: second,
    offset: 0.6,
  });
  await act(() => again.backend.set(anchors.get, checkpoint));
  expect(again.restore).toHaveBeenCalledTimes(1);
});

test("missing, inaccessible, and cross-account rows do not restore or remain cached", async () => {
  expect(DATA_SCOPE.sessionReadAnchors).toBe("viewer");
  expect(REPLICATION_CLASSIFICATION.sessionReadAnchors).toBe("local");
  expect(isPersistedClientStoreKey("sessionReadAnchors")).toBe(false);
  const ui = await open({ answer: checkpoint });
  expect(ui.restore).toHaveBeenCalledTimes(1);
  await act(() => ui.backend.set(anchors.get, null));
  expect(ui.store.getState().sessionReadAnchors).toEqual({});
  await act(() => ui.backend.set(anchors.get, checkpoint));
  const other = "x".repeat(32) as Id<"users">;
  await ui.rerender(<ui.View viewer={other} />);
  expect(ui.restore).toHaveBeenCalledTimes(1);
  expect(ui.store.getState().sessionReadAnchors).toEqual({});
});

test("loads an older checkpoint once and lands at its fraction within the transcript row", async () => {
  const ui = await mountWeb(
    <div id="feed">
      <div data-index="0" data-vkey={second} />
    </div>,
    { clock: true },
  );
  const feed = ui.container.querySelector<HTMLElement>("#feed")!;
  const row = feed.firstElementChild!;
  feed.getBoundingClientRect = () => new DOMRect(0, 100, 800, 400);
  row.getBoundingClientRect = () =>
    new DOMRect(0, 500 - feed.scrollTop, 800, 200);
  const timeline = (id: string): TimelineItem[] => [
    { type: "message", data: { _id: id } as Message, timestamp: 2 },
  ];
  const jumpToTimestamp = mock((_timestamp: number) => {});
  const takePosition = mock(() => {});
  const scrollToIndex = mock(() => {});
  const opts = {
    container: feed,
    timeline: timeline(second),
    virtualizer: { scrollToIndex },
    jumpToTimestamp,
    takePosition,
  };
  expect(
    restoreReadingPosition(checkpoint, false, {
      ...opts,
      timeline: [
        {
          type: "commit",
          timestamp: 1,
          data: {
            _id: "commit",
            sha: "abc",
            message: "Commit",
            timestamp: 1,
            files_changed: 1,
            insertions: 1,
            deletions: 0,
            author_name: "Reader",
            author_email: "reader@example.test",
          },
        },
      ],
    }),
  ).toBe("loading");
  expect(jumpToTimestamp).not.toHaveBeenCalled();
  expect(restoreReadingPosition(checkpoint, false, opts)).toBe("requested");
  expect(jumpToTimestamp.mock.calls).toEqual([[2]]);
  expect(restoreReadingPosition(checkpoint, true, opts)).toBe("loading");
  expect(
    restoreReadingPosition(checkpoint, true, { ...opts, windowLoaded: true }),
  ).toBe("fallback");
  expect(jumpToTimestamp).toHaveBeenCalledTimes(1);
  expect(
    restoreReadingPosition(checkpoint, true, {
      ...opts,
      resolveMessage: () => second,
    }),
  ).toBe("restored");
  const restoreGlobals = replaceGlobals({
    CSS: { escape: (id: string) => id },
  });
  try {
    await ui.clock!.advance(20);
  } finally {
    feed.dispatchEvent(new Event("wheel"));
    restoreGlobals();
  }
  expect(feed.scrollTop).toBe(460);
  expect(scrollToIndex).toHaveBeenCalledWith(0, { align: "start" });
  expect(takePosition).toHaveBeenCalledTimes(1);
});

test("a due checkpoint waits until typing is quiet", async () => {
  const ui = await open();
  await ui.sample(first, 0, false);
  await ui.sample(second, 0.8);
  await ui.clock!.advance(29_999);
  ui.backend.ping();
  noteInputForTests();
  await ui.clock!.advance(1);
  expect(ui.writes()).toEqual([]);
  await ui.clock!.advance(TYPING_QUIET_MS);
  expect(ui.writes()).toHaveLength(1);
});

test("a stalled restore expires and the next real movement can be checkpointed", async () => {
  const ui = await open({ answer: checkpoint, restoreResult: "requested" });
  await ui.clock!.advance(5000);
  expect(ui.restore).toHaveBeenLastCalledWith(checkpoint, true, true, false);
  await ui.sample(second, 0.8);
  ui.backend.ping();
  await ui.clock!.advance(30_000);
  expect(ui.writes()).toHaveLength(1);
});

test("window focus and programmatic movement do not claim or checkpoint again", async () => {
  const ui = await open();
  await ui.sample(first, 0, false);
  await act(() => {
    document.hasFocus = () => false;
    window.dispatchEvent(new Event("blur"));
  });
  await act(() => {
    document.hasFocus = () => true;
    window.dispatchEvent(new Event("focus"));
  });
  await ui.sample(second, 0.8, false);
  ui.backend.ping();
  await ui.clock!.advance(30_000);
  await ui.close();
  expect(dispatches(ui.backend).map((event) => event.action)).toEqual([
    "beginSavedReadingAnchor",
  ]);
});

test.each(["visible tab", "tab hidden while loading"] as const)(
  "ConversationView finishes a bounded anchor restore with %s",
  async (mode) => {
    const jump = mock((_timestamp: number) => {});
    const tail = mock(() => {});
    const view = (isLoadingOlder: boolean) => (
      <ConversationView
        conversation={{
          _id: conversation,
          user_id: user,
          title: "Reading history",
          messages: [
            {
              _id: second,
              timestamp: 10,
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
        onJumpToEnd={tail}
        isLoadingOlder={isLoadingOlder}
      />
    );
    const ui = await mountWeb(view(false), {
      clock: true,
      authenticated: true,
      dispatch: true,
      setup(backend, store) {
        store.syncTable("currentUser", { _id: user });
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
          api.lateJoinSummary.get,
        ])
          backend.set(query, pending);
        backend.mutation(api.users.requestTerminalEndpoints, {
          commands: [],
        });

        backend.set(anchors.get, checkpoint);
        backend.mutation(api.dispatch.dispatch, ({ action }) =>
          action === "beginSavedReadingAnchor" ? viewId : null,
        );
      },
    });
    expect(jump.mock.calls).toEqual([[checkpoint.timestamp]]);
    expect(tail).not.toHaveBeenCalled();
    await ui.rerender(view(false));
    expect(tail).not.toHaveBeenCalled();
    await ui.rerender(view(true));
    expect(tail).not.toHaveBeenCalled();
    if (mode === "tab hidden while loading") {
      for (const visibility of ["hidden", "visible"] as const)
        await act(async () => {
          await setVisibility(visibility);
          await ui.clock!.advance(0);
        });
      expect(tail).not.toHaveBeenCalled();
    }
    await ui.rerender(view(false));
    expect(tail).toHaveBeenCalledTimes(1);
    expect(
      ui.backend.queryRequests.some(
        ({ name }) => name === "conversationReadAnchors:get",
      ),
    ).toBe(true);
    expect(
      dispatches(ui.backend).some(
        ({ action }) => action === "beginSavedReadingAnchor",
      ),
    ).toBe(true);
    await ui.close();
  },
);

test("only scrolls backed by reader input are marked as movement", async () => {
  const ui = await mountWeb(<div id="feed" />, { clock: true });
  const feed = ui.container.querySelector<HTMLElement>("#feed")!;
  const movement = mock((_readerMoved: boolean) => {});
  const stop = watchReadingScroll(feed, movement);
  try {
    const scroll = () => feed.dispatchEvent(new Event("scroll"));
    scroll();
    feed.dispatchEvent(new window.WheelEvent("wheel", { deltaY: 10 }));
    scroll();
    scroll();
    expect(movement.mock.calls).toEqual([[false], [true], [false]]);
  } finally {
    stop();
    await ui.close();
  }
});

test("a collapsed turn resolves to its visible text row, and an open turn keeps its exact row", () => {
  const turn = {
    absorbed: new Set<string>(),
    receiptOf: new Map(),
    turnKeyOf: new Map([[first, "turn"]]),
    lastTextOf: new Map([["turn", second]]),
    firstAssistOf: new Map([["turn", first]]),
  };
  expect(readingRowForMessage(first, "compact", turn, new Set())).toBe(second);
  expect(readingRowForMessage(first, "compact", turn, new Set(["turn"]))).toBe(
    first,
  );
});

async function setVisibility(visibilityState: DocumentVisibilityState) {
  await act(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: visibilityState,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

test("a begin reply after the visit ends cannot flush its position", async () => {
  const pendingBegin = Promise.withResolvers<string>();
  const ui = await open({ beginReply: () => pendingBegin.promise });
  await ui.sample(first, 0, false);
  await ui.sample(second, 0.8);
  await setVisibility("hidden");
  await act(() => pendingBegin.resolve(viewId));
  expect(ui.writes()).toEqual([]);
});

test("an ended visit does not retry a failed begin request", async () => {
  const ui = await open({
    beginReply: () => new Error("Disconnected"),
    beginError: true,
  });
  const claimCount = () =>
    dispatches(ui.backend).filter(
      ({ action }) => action === "beginSavedReadingAnchor",
    ).length;
  expect(claimCount()).toBe(1);
  await setVisibility("hidden");
  await ui.clock!.advance(8000);
  expect(claimCount()).toBe(1);
});

test("showing the same mounted view claims again without restoring again", async () => {
  const ui = await open({ answer: checkpoint });
  await setVisibility("hidden");
  await act(async () => {
    await setVisibility("visible");
    await ui.clock!.advance(0);
  });
  const claims = dispatches(ui.backend).filter(
    ({ action }) => action === "beginSavedReadingAnchor",
  );
  expect(claims).toHaveLength(2);
  expect(claims[0].args[1].session).toEqual(expect.any(String));
  expect(claims[1].args[1].session).toBe(claims[0].args[1].session);
  expect(claims[1].args[1].order).toBe(claims[0].args[1].order + 1);
  expect(ui.restore).toHaveBeenCalledTimes(1);
  await ui.close();
});

test("a visit opened before dispatch wiring claims and saves after wiring", async () => {
  const ui = await open({ wireLate: true });
  expect(ui.backend.mutations).toEqual([]);
  await ui.sample(first, 0, false);
  await ui.sample(second, 0.8);
  ui.store
    .getState()
    ._setDispatch(
      makeDispatchBinding((args) =>
        ui.backend.client.mutation(api.dispatch.dispatch, args),
      ),
    );
  await ui.clock!.advance(100);
  expect(dispatches(ui.backend).map(({ action }) => action)).toEqual([
    "beginSavedReadingAnchor",
  ]);
  await ui.close();
  expect(ui.writes()).toHaveLength(1);
});
