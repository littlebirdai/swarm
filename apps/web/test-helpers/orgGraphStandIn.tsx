import { spyOn } from "bun:test";
import * as graph from "../components/org/OrgGraph";

export function standInForOrgGraph() {
  const render = spyOn(graph, "OrgGraph").mockImplementation(({ lens }) => (
    <div data-graph-lens={lens} />
  ));
  return {
    last() {
      const props = render.mock.lastCall?.[0];
      if (!props) throw new Error("The org graph did not render");
      return props;
    },
    restore: () => render.mockRestore(),
  };
}
