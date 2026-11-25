import { expect, test } from "bun:test";
import { act } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { mountWeb } from "../../test-helpers/mountWeb";
import { TeamFindableNudge } from "../team/TeamFindableNudge";

const teamId = "t1" as Id<"teams">;
const nudge = { domain: "littlebird.ai", coworkers_outside: 7 };

const mount = (role: "admin" | "member") =>
  mountWeb(<TeamFindableNudge teamId={teamId} teamName="Littlebird" />, {
    dispatch: true,
    setup: (backend, store) => {
      store.syncTable("teams", [{ _id: teamId, name: "Littlebird", role }]);
      backend.set(api.teamDiscovery.discoveryNudge, nudge);
      backend.mutation(api.teamDiscovery.setDiscoverable, undefined);
      backend.mutation(api.dispatch.dispatch, undefined);
    },
  });

const click = (container: HTMLElement, label: string) =>
  act(async () => {
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === label)!
      .click();
  });

test("an admin sees how many coworkers are outside and opens the team in one click", async () => {
  const { backend, container } = await mount("admin");
  expect(backend.queryRequests).toEqual([
    { name: "teamDiscovery:discoveryNudge", args: { team_id: teamId } },
  ]);
  expect(container.textContent).toContain(
    "7 people with @littlebird.ai addresses use codecast but aren't on Littlebird.",
  );
  await click(container, "Let them find it");
  expect(backend.mutations).toEqual([
    {
      name: "teamDiscovery:setDiscoverable",
      args: { team_id: teamId, enabled: true },
    },
  ]);
  expect(container.querySelector(".tf-accent-card")).toBeNull();
});

test("Not now snoozes it", async () => {
  const { container, store } = await mount("admin");
  await click(container, "Not now");
  expect(
    store.getState().clientState.dismissed?.team_findable_nudge,
  ).toBeGreaterThan(0);
  expect(container.querySelector(".tf-accent-card")).toBeNull();
});

test("a member never asks", async () => {
  const { backend, container } = await mount("member");
  expect(backend.queryRequests).toEqual([]);
  expect(container.textContent).toBe("");
});
