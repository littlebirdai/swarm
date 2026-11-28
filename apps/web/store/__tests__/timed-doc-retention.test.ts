import { expect, jest, test } from "bun:test";
import { pinDetailRows } from "../../lib/detail-rows";
import { noteInputForTests } from "../../lib/inputQuiet";
import { webBuilders } from "../../test-helpers/builders";
import { replaceGlobals } from "../../test-helpers/globals";
import { partitionDocDetailRetention } from "../cacheRetention";
import {
  __createInboxStoreForTests,
  type InboxStoreState,
} from "../inboxStore";
import { startTimedDocRetention } from "../timed-doc-retention";

test("a week of live writes settles to the fresh-cache cap without dropping protected docs", () => {
  const restore = replaceGlobals({
    document: Object.assign(new EventTarget(), { hidden: false }),
  });
  const store = __createInboxStoreForTests();
  const now = Date.now();
  const day = 86_400_000;
  const history: InboxStoreState["docDetails"][string][] = [];
  const pinned = "j".repeat(32);
  const pending = "k".repeat(32);
  const listPinned = "l".repeat(32);
  const release = pinDetailRows("docDetails", [pinned]);
  const { doc } = webBuilders("timed-doc-retention");
  let notifications = 0;
  store.subscribe(() => notifications++);
  store.setState({
    docs: { [listPinned]: doc.build({ _id: listPinned, pinned: true }) },
    pending: {
      [`docs:${pending}:title`]: { type: "field", ts: 1, value: "draft" },
    },
  });
  jest.useFakeTimers();
  const sweep = startTimedDocRetention(store.getState, () => true);
  try {
    const add = (id: string, updated_at: number) => {
      const row = {
        _id: id,
        updated_at,
        title: id,
      } as InboxStoreState["docDetails"][string];
      history.push(row);
      store.getState().syncRecord("docDetails", id, row);
    };
    add(pinned, now - day * 31);
    add(pending, now - day * 31);
    add(listPinned, now - day * 31);
    for (let d = 0; d < 7; d++) {
      for (let i = 0; i < 50; i++) {
        const id = `m${String(d * 50 + i).padStart(31, "0")}`;
        add(id, now + d * day + i);
      }
      jest.advanceTimersByTime(day);
    }
    expect(store.getState().docDetails[listPinned]).toBeDefined();
    const fresh = partitionDocDetailRetention(
      history,
      Date.now(),
      new Set([pinned, pending, listPinned]),
    );
    expect(Object.keys(store.getState().docDetails).sort()).toEqual(
      fresh.keep.map((row) => row._id).sort(),
    );
    const writes = notifications;
    jest.advanceTimersByTime(10 * 60_000);
    expect(notifications).toBe(writes);
  } finally {
    sweep.stop();
    jest.useRealTimers();
    release();
    restore();
  }
});

test("the first batch waits for quiet", () => {
  const restore = replaceGlobals({
    document: Object.assign(new EventTarget(), { hidden: false }),
    performance: { now: () => Date.now() },
  });
  const store = __createInboxStoreForTests();
  const id = "l".repeat(32);
  store.getState().syncRecord("docDetails", id, { _id: id, updated_at: 1 });
  jest.useFakeTimers();
  noteInputForTests();
  const sweep = startTimedDocRetention(store.getState, () => true);
  try {
    jest.advanceTimersByTime(0);
    expect(store.getState().docDetails[id]).toBeDefined();
    jest.advanceTimersByTime(401);
    expect(store.getState().docDetails[id]).toBeUndefined();
  } finally {
    sweep.stop();
    jest.useRealTimers();
    restore();
  }
});

test("hidden windows cancel the timer, resume immediately, and cannot restart after stop", () => {
  const document = Object.assign(new EventTarget(), { hidden: true });
  const restore = replaceGlobals({ document });
  const store = __createInboxStoreForTests();
  let attempts = 0;
  jest.useFakeTimers();
  const sweep = startTimedDocRetention(store.getState, () => {
    attempts++;
    return false;
  });
  const show = (visible: boolean) => {
    document.hidden = !visible;
    document.dispatchEvent(new Event("visibilitychange"));
  };
  try {
    expect(jest.getTimerCount()).toBe(0);
    show(true);
    jest.advanceTimersByTime(0);
    expect(attempts).toBe(1);
    expect(jest.getTimerCount()).toBe(1);
    show(false);
    sweep.soon();
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(10 * 60_000);
    expect(attempts).toBe(1);
    show(true);
    jest.advanceTimersByTime(0);
    expect(attempts).toBe(2);
    sweep.stop();
    sweep.soon();
    show(false);
    show(true);
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    sweep.stop();
    jest.useRealTimers();
    restore();
  }
});
