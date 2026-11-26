import { expect, mock, test } from "bun:test";
import { act, useLayoutEffect } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import {
  useSavedReadingAnchor,
  type SavedReadingAnchor,
} from "../use-saved-reading-anchor";
import { replaceGlobals } from "../../test-helpers/globals";
import { mountWeb } from "../../test-helpers/mountWeb";
import { pending } from "../../test-helpers/testConvex";
import { noteInputForTests, TYPING_QUIET_MS } from "../../lib/inputQuiet";
import { restoreReadingPosition } from "../../components/conversation/reading-viewport";
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
  enabled = true,
  answer = null,
  lostExit = false,
}: {
  enabled?: boolean;
  answer?: SavedReadingAnchor | typeof pending | null;
  lostExit?: boolean;
} = {}) {
  const restore = mock(
    (_anchor: SavedReadingAnchor, _requestedWindow: boolean) =>
      "restored" as const,
  );
  type Observe = ReturnType<typeof useSavedReadingAnchor>;
  let observe: Observe;
  let saved = answer === pending ? null : answer;
  let saves = 0;
  function View({ viewer = user }: { viewer?: Id<"users"> }) {
    const measure = useSavedReadingAnchor({
      conversationId: conversation,
      userId: viewer,
      enabled,
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
    expectedConsoleErrors: lostExit
      ? [/CONVEX M\(conversationReadAnchors:save\).*Disconnected/]
      : [],
    setup(backend) {
      document.hasFocus = () => true;
      backend.set(anchors.get, answer);
      backend.mutation(anchors.begin, viewId);
      backend.mutation(anchors.save, (args) => {
        saves++;
        if (lostExit && saves > 1) return new Error("Disconnected");
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
    ui.backend.mutations.filter(
      (event) => event.name === "conversationReadAnchors:save",
    );
  return { ...ui, sample, writes, restore, View, saved: () => saved };
}

test("the default-off path does not subscribe, claim a view, save, or change landing", async () => {
  const ui = await open({ enabled: false, answer: checkpoint });
  await ui.sample(first, 0, false);
  await ui.sample(second, 0.7);
  await ui.clock!.advance(30_000);
  ui.backend.ping();
  await ui.clock!.advance(30_000);
  await ui.close();
  expect(
    ui.backend.queryRequests.filter((q) =>
      q.name.startsWith("conversationReadAnchors:"),
    ),
  ).toEqual([]);
  expect(ui.backend.mutations).toEqual([]);
  expect(ui.restore).not.toHaveBeenCalled();
  expect(ui.store.getState().sessionReadAnchors).toEqual({});
});

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
  expect(ui.restore).toHaveBeenCalledWith(checkpoint, false);
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
      <div data-index="0" data-vkey={first} />
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
  expect(restoreReadingPosition(checkpoint, false, opts)).toBe("requested");
  expect(jumpToTimestamp.mock.calls).toEqual([[2]]);
  expect(restoreReadingPosition(checkpoint, true, opts)).toBe("loading");
  expect(jumpToTimestamp).toHaveBeenCalledTimes(1);
  expect(
    restoreReadingPosition(checkpoint, true, {
      ...opts,
      timeline: timeline(first),
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
