import { expect, test } from "bun:test";
import { api } from "@codecast/convex/convex/_generated/api";
import { webBuilders } from "../../test-helpers/builders";
import { mountWeb } from "../../test-helpers/mountWeb";
import { useInboxStore } from "../../store/inboxStore";
import { useLiveInboxSessions } from "../useLiveInboxSessions";

const timeout = new Error(
  "Function execution timed out (maximum duration: 1s)",
);

function Probe() {
  const { data, error } = useLiveInboxSessions();
  return (
    <span data-error={error ? "yes" : "no"}>{data ? "live" : "cache"}</span>
  );
}

test("the 1s user-code timeout renders as a value and leaves the cached rows alone", async () => {
  const cached = webBuilders(
    "useLiveInboxSessions.error.test.tsx",
  ).session.build();
  const { container, store } = await mountWeb(<Probe />, {
    setup: (backend, state) => {
      state.syncTable("sessions", [cached]);
      useInboxStore.setState({ syncRole: "host" });
      backend.set(api.conversations.listInboxSessions, timeout);
    },
  });
  expect(container.querySelector("span")?.outerHTML).toBe(
    '<span data-error="yes">cache</span>',
  );
  expect(Object.keys(store.getState().sessions)).toEqual([cached._id]);
});
