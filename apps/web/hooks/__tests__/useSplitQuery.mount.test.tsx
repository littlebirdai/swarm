import { expect, mock, test } from "bun:test";
import { splitRows } from "@codecast/shared/contracts/inboxSplit";
import { makeFunctionReference } from "convex/server";
import { JSDOM } from "jsdom";
import { act } from "react";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import { replaceGlobals } from "../../test-helpers/globals";

test("the live reader requests split and does not replay a previous team's result", async () => {
  const dom = new JSDOM("<div id='host'></div>");
  const restore = replaceGlobals({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const query = makeFunctionReference<"query">("test:teamLiveness");
  const { ids, cold_hash } = splitRows([], Date.now());
  const alpha = {
    split: true,
    ids,
    hot: {},
    cold_hash,
    projection: { team_id: "alpha" },
  };
  const convex = { query: mock() };
  const real = await import("convex/react");
  const subscribe = mock(
    (queries: { value?: { args: { activeTeamId: string } } }) =>
      queries.value?.args.activeTeamId === "alpha" ? { value: alpha } : {},
  );
  mock.module("convex/react", () => ({
    ...real,
    useConvex: () => convex,
    useQueries: subscribe,
  }));
  const { createRoot } = await import("react-dom/client");
  const { useSplitQueryNoThrow } = await import("../useSplitQuery");
  const host = document.getElementById("host")!;
  const root = createRoot(host);
  function Probe({ team }: { team: string }) {
    const { data } = useSplitQueryNoThrow(
      query,
      { activeTeamId: team },
      "liveness",
    );
    return <span>{data?.projection.team_id}</span>;
  }
  try {
    await act(async () => root.render(<Probe team="alpha" />));
    expect(subscribe).toHaveBeenLastCalledWith({
      value: { query, args: { activeTeamId: "alpha", split: true } },
    });
    expect(host.textContent).toBe("alpha");
    expect(convex.query).not.toHaveBeenCalled();

    await act(async () => root.render(<Probe team="beta" />));
    expect(subscribe).toHaveBeenLastCalledWith({
      value: { query, args: { activeTeamId: "beta", split: true } },
    });
    expect(host.textContent).toBe("");
  } finally {
    await act(async () => root.unmount());
    mock.module("convex/react", () => real);
    closeDomWindow(dom);
    restore();
  }
});
