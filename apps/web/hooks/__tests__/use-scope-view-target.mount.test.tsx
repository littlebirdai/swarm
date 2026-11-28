import { expect, test } from "bun:test";
import { mountWeb } from "../../test-helpers/mountWeb";
import { useInboxStore } from "../../store/inboxStore";
import { useScopeViewTarget } from "../use-scope-view-target";

function ProjectScreen({ id }: { id: string }) {
  useScopeViewTarget("project", id);
  return <span>{id}</span>;
}

test("a screen holds its view target while mounted and drops it on unmount", async () => {
  const mounted = await mountWeb(<ProjectScreen id="p1" />);
  const targets = () =>
    Object.values(useInboxStore.getState().scopeViewTargets).flat();
  expect(targets()).toEqual([{ kind: "project", id: "p1" }]);
  await mounted.rerender(<ProjectScreen id="p2" />);
  expect(targets()).toEqual([{ kind: "project", id: "p2" }]);
  await mounted.rerender(<span />);
  expect(targets()).toEqual([]);
});
