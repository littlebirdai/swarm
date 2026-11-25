import { expect, spyOn, test } from "bun:test";
import { splitRows } from "@codecast/inbox/inboxSplit";
import { makeFunctionReference } from "convex/server";
import { mountWeb } from "../../test-helpers/mountWeb";
import { pending } from "../../test-helpers/testConvex";
import { useSplitQueryNoThrow } from "../useSplitQuery";

const query = makeFunctionReference<"query">("test:teamLiveness");

function Probe({ team }: { team: string }) {
  const { data } = useSplitQueryNoThrow(
    query,
    { activeTeamId: team },
    "liveness",
  );
  return <span>{data?.projection.team_id}</span>;
}

test("the live reader requests split and does not replay a previous team's result", async () => {
  const { ids, cold_hash } = splitRows([], 1_800_000_000_000);
  const alpha = {
    split: true,
    ids,
    hot: {},
    cold_hash,
    projection: { team_id: "alpha" },
  };
  let queryCallCount: (() => number) | undefined;
  const { backend, container, rerender } = await mountWeb(
    <Probe team="alpha" />,
    {
      setup: (backend) => {
        const querySpy = spyOn(backend.client, "query");
        queryCallCount = () => querySpy.mock.calls.length;
        backend.set(query, ({ activeTeamId }) =>
          activeTeamId === "alpha" ? alpha : pending,
        );
      },
    },
  );
  expect(backend.queryRequests).toEqual([
    { name: "test:teamLiveness", args: { activeTeamId: "alpha", split: true } },
  ]);
  expect(container.textContent).toBe("alpha");

  await rerender(<Probe team="beta" />);
  expect(backend.queryRequests).toEqual([
    { name: "test:teamLiveness", args: { activeTeamId: "alpha", split: true } },
    { name: "test:teamLiveness", args: { activeTeamId: "beta", split: true } },
  ]);
  expect(container.textContent).toBe("");
  expect(queryCallCount?.()).toBe(0);
});
