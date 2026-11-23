import { expect, test } from "bun:test";
import { act } from "react";
import { ConvexProvider, type ConvexReactClient } from "convex/react";
import { JSDOM } from "jsdom";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import { replaceGlobals } from "../../test-helpers/globals";
import { useSyncTriggerHistory } from "../useSyncTriggers";
import { useInboxStore } from "../../store/inboxStore";

function HistoryFeed() {
  useSyncTriggerHistory();
  return null;
}

test("the trigger history feeder keeps cached rows until the last page arrives", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://localhost/" });
  const restore = replaceGlobals({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.window.document.getElementById("root")!);
  const cached = { _id: "a".repeat(32), status: "completed" };
  const older = { _id: "b".repeat(32), status: "failed" };
  const recent = { _id: "c".repeat(32), status: "completed" };
  const first = { page: [recent], isDone: false, continueCursor: "older" };
  const last = { page: [older], isDone: true, continueCursor: "" };
  let lastResult: typeof last | undefined;
  let notifyLastPage: (() => void) | undefined;
  const client = {
    watchQuery: (_query: unknown, args: { paginationOpts: { cursor: string | null } }) => {
      const firstPage = args.paginationOpts.cursor === null;
      return {
        localQueryResult: () => firstPage ? first : lastResult,
        onUpdate: (notify: () => void) => {
          if (!firstPage) notifyLastPage = notify;
          return () => {};
        },
      };
    },
  } as unknown as ConvexReactClient;
  const store = useInboxStore.getState();
  const originalRows = Object.values(store.agentTasks);
  const ids = () => Object.keys(useInboxStore.getState().agentTasks).sort();

  try {
    store.syncTable("agentTasks", [cached]);
    await act(async () => root.render(<ConvexProvider client={client}><HistoryFeed /></ConvexProvider>));
    expect(notifyLastPage).toBeDefined();
    expect(ids()).toEqual([cached._id]);

    await act(async () => {
      lastResult = last;
      notifyLastPage?.();
    });
    expect(ids()).toEqual([older._id, recent._id]);
  } finally {
    await act(async () => root.unmount());
    store.syncTable("agentTasks", originalRows);
    closeDomWindow(dom);
    restore();
  }
});
