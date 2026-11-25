import { describe, expect, test } from "bun:test";
import { ConvexProviderWithAuth, useConvex } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { mountWeb } from "../../test-helpers/mountWeb";
import { pending } from "../../test-helpers/testConvex";
import { useSyncCollection } from "../useSyncCollection";
import { authSettledLatch } from "../useServerAuthSettled";

const events = makeFunctionReference<"query">("externalEvents:listForTeam");

function Probe() {
  const { ready } = useSyncCollection("externalEvents", events, { limit: 200 });
  return <span data-ready={ready} />;
}

function PendingIdentity() {
  const client = useConvex();
  return (
    <ConvexProviderWithAuth
      client={client}
      useAuth={() => ({
        isLoading: true,
        isAuthenticated: false,
        fetchAccessToken: async () => null,
      })}
    >
      <Probe />
    </ConvexProviderWithAuth>
  );
}

describe("useSyncCollection — the authenticated-feeder gate", () => {
  test("sends nothing while the server has not confirmed the caller", async () => {
    const { backend } = await mountWeb(<PendingIdentity />);
    expect(backend.queryRequests).toEqual([]);
  });

  for (const authenticated of [true, false]) {
    test(
      authenticated
        ? "sends the query once the server has confirmed the caller"
        : "subscribes as before when there is no auth provider",
      async () => {
        const { backend } = await mountWeb(<Probe />, {
          authenticated,
          setup: (backend) => backend.set(events, pending),
        });
        expect(backend.queryRequests).toEqual([
          { name: "externalEvents:listForTeam", args: { limit: 200 } },
        ]);
      },
    );
  }
});

describe("authSettledLatch", () => {
  test("opens on the first confirmation", () => {
    expect(authSettledLatch(false, false)).toBe(false);
    expect(authSettledLatch(false, true)).toBe(true);
  });

  test("stays open through a token refresh dropping the signal", () => {
    expect(authSettledLatch(true, false)).toBe(true);
  });
});
