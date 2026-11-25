import { expect, test } from "bun:test";
import { api } from "@codecast/convex/convex/_generated/api";
import { mountWeb } from "../../test-helpers/mountWeb";
import { pending } from "../../test-helpers/testConvex";
import { useSyncTrial } from "../useSyncTrial";

const workspace = "team:t1";
const error = new Error("lineTrial:cards timed out");

function Probe() {
  const { ready, error } = useSyncTrial(workspace);
  return <span data-ready={ready} data-error={error?.message} />;
}

test("a trial cards error leaves cached cards in place", async () => {
  const cached = {
    _id: "tc_row_1",
    workspace,
    short_id: "tc-1",
    status: "waiting",
    created_at: 1,
    updated_at: 1,
  };
  const { container, store } = await mountWeb(<Probe />, {
    setup: (backend, store) => {
      store.syncTable("trialCards", [cached]);
      backend.set(api.lineTrial.cards, error);
      backend.set(api.lineTrial.projects, pending);
      backend.set(api.lineTrial.runs, pending);
    },
  });
  const probe = container.querySelector("span");
  expect(probe?.dataset.ready).toBe("false");
  expect(probe?.dataset.error).toContain(error.message);
  expect(store.getState().trialCards[cached._id]).toEqual(cached);
});
