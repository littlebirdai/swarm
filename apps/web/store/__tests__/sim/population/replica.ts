import { getFunctionName } from "convex/server";
import { api } from "@codecast/convex/convex/_generated/api";
import type {
  SimBackend,
  SimClient,
} from "@codecast/convex/convex/simBackend.testing";
import { catchUpScope } from "../../../../hooks/useSyncChangeFeed";
import { createWindowStore, runInWindow } from "../realm";
import type { Person } from "./model";
import { fixtureId } from "./workload";

type Head = {
  scope_key: string;
  position: number;
  floor: number;
};

export function populationReplica(backend: SimBackend, person: Person) {
  const name = `population-${person.id}`;
  const window = { name, store: createWindowStore(name) };
  const client = backend.clientFor({
    kind: "user",
    userId: fixtureId("users", person.id),
  });
  const encoder = new TextEncoder();
  const totals = {
    person: person.id,
    team: person.team,
    events: 0,
    teamEvents: 0,
    bytes: 0,
    rangeBytes: 0,
    taskIdsRefetched: 0,
  };
  const meter = {
    async query(
      ref: Parameters<SimClient["query"]>[0],
      args: Record<string, unknown>,
    ) {
      const result = await client.query(ref, args);
      const bytes = encoder.encode(JSON.stringify(result)).byteLength;
      totals.bytes += bytes;
      const name = getFunctionName(ref);
      if (name === "tasks:webGetByIds" && Array.isArray(args.ids))
        totals.taskIdsRefetched += args.ids.length;
      if (name === "syncLog:getRange") {
        totals.rangeBytes += bytes;
        totals.events += result.actions.length;
        if (String(args.scope_key).startsWith("team:"))
          totals.teamEvents += result.actions.length;
      }
      return result;
    },
  };

  return {
    async poll() {
      const { heads }: { heads: Head[] } = await meter.query(
        api.syncLog.getHeads,
        {},
      );
      await runInWindow(window, async () => {
        const purgedTeams = new Set<string>();
        for (const head of heads) await catchUpScope(meter, head, purgedTeams);
      });
    },
    result(expectedTitles: ReadonlyMap<string, string>) {
      const tasks = Object.values(window.store.getState().tasks);
      return {
        ...totals,
        rows: tasks.length,
        staleTaskTitles: tasks.filter(
          ({ _id, title }) => expectedTitles.get(String(_id)) !== title,
        ).length,
      };
    },
  };
}
