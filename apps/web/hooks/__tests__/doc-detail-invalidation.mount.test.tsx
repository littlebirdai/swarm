import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import { mountWeb } from "../../test-helpers/mountWeb";
import { useInboxStore } from "../../store/inboxStore";
import { flushSyncPublishes } from "../../store/syncTransaction";
import { hideInvalidatedDetails } from "../../store/doc-detail-authority";
import {
  resetDetailInvalidations,
  setDetailInvalidationReporter,
} from "../../store/doc-detail-cache";
import { useSyncDocDetail } from "../use-sync-docs";

const flag = "VITE_CACHE_EVICTION_METADATA";
const original = process.env[flag];
const id = "j".repeat(32);
const row = { _id: id, title: "Doc", content: "Has a body", updated_at: 1 };

afterEach(() => {
  resetDetailInvalidations();
  if (original === undefined) delete process.env[flag];
  else process.env[flag] = original;
});

function Body() {
  useSyncDocDetail(id);
  const body = useInboxStore((state) => state.docDetails[id]?.content);
  return <p>{body ?? "No body"}</p>;
}

test("resolved access loss reports authority even when a detail was already evicted", async () => {
  process.env[flag] = "1";
  const ui = await mountWeb(<Body />, {
    authenticated: true,
    setup(backend) {
      backend.set(api.taskMining.webGetDocDetail, row);
    },
  });
  const reports: unknown[] = [];
  setDetailInvalidationReporter((evidence) => {
    reports.push(evidence);
    hideInvalidatedDetails(evidence.ids);
  });
  await act(async () => {
    ui.store.getState().dropDocDetail(id);
    ui.backend.set(api.taskMining.webGetDocDetail, null);
    flushSyncPublishes();
  });
  expect(ui.container.textContent).toBe("No body");
  expect(reports).toEqual([{ cause: "access", ids: [id] }]);
});

test("a gap hides the body until a current authority read refills it", async () => {
  process.env[flag] = "1";
  const current = Promise.withResolvers<typeof row>();
  const ui = await mountWeb(<Body />, {
    authenticated: true,
    setup(backend) {
      backend.set(api.taskMining.webGetDocDetail, row);
    },
  });
  setDetailInvalidationReporter(
    () => {},
    () => current.promise,
  );
  await act(async () => flushSyncPublishes());
  expect(ui.container.textContent).toBe(row.content);
  await act(async () => {
    hideInvalidatedDetails();
    flushSyncPublishes();
  });
  expect(ui.container.textContent).toBe("No body");
  await act(async () => {
    ui.backend.set(api.taskMining.webGetDocDetail, {
      ...row,
      content: "An older queued answer",
    });
    flushSyncPublishes();
  });
  expect(ui.container.textContent).toBe("No body");
  await act(async () =>
    current.resolve({ ...row, content: "Current authorized result" }),
  );
  await act(async () => flushSyncPublishes());
  expect(ui.container.textContent).toBe("Current authorized result");
});

test("an optimistic archive reports authority only after dispatch confirms it", async () => {
  process.env[flag] = "1";
  const accepted = Promise.withResolvers<null>();
  const ui = await mountWeb(<Body />, {
    authenticated: true,
    dispatch: true,
    setup(backend) {
      backend.set(api.taskMining.webGetDocDetail, row);
      backend.mutation(api.dispatch.dispatch, ({ action }) => {
        expect(action).toBe("archiveDoc");
        return accepted.promise;
      });
    },
  });
  const reports: unknown[] = [];
  setDetailInvalidationReporter((evidence) => reports.push(evidence));
  await act(async () => {
    void ui.store.getState().archiveDoc(id);
  });
  expect(ui.container.textContent).toBe("No body");
  expect(reports).toEqual([]);
  await act(async () => accepted.resolve(null));
  expect(reports).toEqual([{ ids: [id], cause: "archive" }]);
});
