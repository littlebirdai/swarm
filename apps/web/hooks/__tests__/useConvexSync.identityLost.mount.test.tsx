import { describe, expect, spyOn, test } from "bun:test";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { ConvexProviderWithAuth, useConvex } from "convex/react";
import { act, type ReactNode } from "react";
import { webBuilders } from "../../test-helpers/builders";
import { mountWeb } from "../../test-helpers/mountWeb";
import { useConvexSync } from "../useConvexSync";
import { useSyncTeams } from "../useSyncTeams";

const { teamMember } = webBuilders("useConvexSync.identityLost.mount.test.tsx");
const member = teamMember.build();
const team = {
  _id: "k97cc9y1a48swe3kfnwcs44a857wmxj2" as Id<"teams">,
  name: "Union",
  icon: undefined,
  icon_color: undefined,
  task_statuses: undefined,
  features: { calls: true },
  default_flow: undefined,
  policy: undefined,
  role: "member" as const,
  joined_at: 100,
  visibility: "full" as const,
  visibility_history: undefined,
  member_count: 3,
  shared_project_count: 0,
  client_key: undefined,
};

async function fetchAccessToken() {
  const claims = Buffer.from(JSON.stringify({ iat: 1, exp: 3601 })).toString(
    "base64url",
  );
  return "eyJhbGciOiJIUzI1NiJ9." + claims + ".test";
}

function Identity({
  authenticated,
  children,
}: {
  authenticated: boolean;
  children: ReactNode;
}) {
  const client = useConvex();
  return (
    <ConvexProviderWithAuth
      client={client}
      useAuth={() => ({
        isAuthenticated: authenticated,
        isLoading: false,
        fetchAccessToken,
      })}
    >
      {children}
    </ConvexProviderWithAuth>
  );
}

describe("useConvexSync while the server identity is lost", () => {
  test("applies nothing between the loss and the re-authenticated answer", async () => {
    const applied: unknown[] = [];
    function Probe({ data }: { data: unknown }) {
      useConvexSync(data, (value) => applied.push(value));
      return null;
    }
    const view = (authenticated: boolean, data: unknown) => (
      <Identity authenticated={authenticated}>
        <Probe data={data} />
      </Identity>
    );
    const web = await mountWeb(view(true, undefined));
    await web.rerender(view(true, ["mine"]));
    const strangers: unknown[] = [];
    await web.rerender(view(false, strangers));
    await web.rerender(view(true, strangers));
    await web.rerender(view(true, ["mine", "new"]));
    expect(applied).toEqual([["mine"], ["mine", "new"]]);
  });

  test("a caller the server never confirmed (a guest) applies as before", async () => {
    const applied: unknown[] = [];
    function Probe() {
      useConvexSync(["public"], (value) => applied.push(value));
      return null;
    }
    await mountWeb(
      <Identity authenticated={false}>
        <Probe />
      </Identity>,
    );
    expect(applied).toEqual([["public"]]);
  });
});

test("useSyncTeams keeps the teams it knew and never repairs the active team after identity loss", async () => {
  function Probe() {
    useSyncTeams();
    return null;
  }
  const view = (authenticated: boolean) => (
    <Identity authenticated={authenticated}>
      <Probe />
    </Identity>
  );
  const web = await mountWeb(view(true), {
    dispatch: true,
    setup(backend, store) {
      store.syncTable("currentUser", member);
      store.syncTable("clientState", { ui: { active_team_id: team._id } });
      backend.set(api.teams.getUserTeams, [team]);
      backend.mutation(api.dispatch.dispatch, null);
    },
  });
  expect(web.store.getState().teams.map(({ _id }) => _id)).toEqual([team._id]);
  await web.rerender(view(false));
  const timers = spyOn(globalThis, "setTimeout");
  try {
    await act(async () => {
      web.backend.set(api.teams.getUserTeams, []);
    });
    const repairDelays = timers.mock.calls
      .map(([, delay]) => delay ?? 0)
      .filter((delay) => delay >= 5000 && delay < 60_000);
    expect(repairDelays).toEqual([]);
  } finally {
    timers.mockRestore();
  }
  expect(web.store.getState().teams.map(({ _id }) => _id)).toEqual([team._id]);
  expect(web.store.getState().clientState.ui?.active_team_id).toBe(team._id);
  expect(web.backend.mutations).toEqual([]);
});
