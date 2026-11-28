import { getFunctionName } from "convex/server";
import { api } from "@codecast/convex/convex/_generated/api";
import type {
  SimBackend,
  SimClient,
} from "@codecast/convex/convex/simBackend.testing";
import { catchUpScope } from "../../../../hooks/use-sync-change-feed";
import { createWindowStore, runInWindow } from "../realm";
import type { Person } from "./model";
import { fixtureId } from "./workload";

type Head = {
  scope_key: string;
  position: number;
  floor: number;
};

export type PopulationMode = "all-projects" | "interest";

export function interestScopesForPerson(person: Person): string[] {
  return [
    `user:${fixtureId("users", person.id)}`,
    ...person.follows.map(
      (project) => `project:${fixtureId("projects", project)}`,
    ),
  ];
}

export function populationReplica(
  backend: SimBackend,
  person: Person,
  options:
    | PopulationMode
    | {
        mode?: PopulationMode;
        allProjectIndices?: readonly number[];
        teamId?: string;
        extraDeniedScopes?: string[];
      } = "interest",
) {
  const mode =
    typeof options === "string" ? options : (options.mode ?? "interest");
  const extraDeniedScopes =
    typeof options === "string" ? [] : (options.extraDeniedScopes ?? []);
  const allProjectIndices =
    typeof options === "string" ? [] : (options.allProjectIndices ?? []);
  const teamId = typeof options === "string" ? undefined : options.teamId;
  const name = `population-${person.id}`;
  const window = { name, store: createWindowStore(name) };
  const client = backend.clientFor({
    kind: "user",
    userId: fixtureId("users", person.id),
  });
  const subscribedScopes =
    mode === "interest"
      ? [...interestScopesForPerson(person), ...extraDeniedScopes]
      : [
          `user:${fixtureId("users", person.id)}`,
          ...(teamId ? [`dir:${teamId}`] : []),
          ...allProjectIndices.map(
            (project) => `project:${fixtureId("projects", project)}`,
          ),
        ];
  const encoder = new TextEncoder();
  const refused = new Set<string>();
  const totals = {
    person: person.id,
    eventsByEntity: {} as Record<string, number>,
    events: 0,
    teamEvents: 0,
    interestEvents: 0,
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
        for (const { entity_type } of result.actions) {
          totals.eventsByEntity[entity_type] =
            (totals.eventsByEntity[entity_type] ?? 0) + 1;
        }
        const scope = String(args.scope_key);
        if (scope.startsWith("team:"))
          totals.teamEvents += result.actions.length;
        else if (!scope.startsWith("user:"))
          totals.interestEvents += result.actions.length;
      }
      return result;
    },
  };

  return {
    async poll() {
      const { heads }: { heads: Head[] } = await meter.query(
        api.syncLog.getHeads,
        subscribedScopes ? { scopes: subscribedScopes } : {},
      );
      if (subscribedScopes) {
        const returned = new Set(heads.map((h) => h.scope_key));
        for (const requested of subscribedScopes) {
          if (!returned.has(requested)) refused.add(requested);
        }
      }
      await runInWindow(window, async () => {
        const purgedTeams = new Set<string>();
        for (const head of heads) await catchUpScope(meter, head, purgedTeams);
      });
    },
    result(
      expectedTitles: ReadonlyMap<string, string>,
      expectedDocTitles: ReadonlyMap<string, string>,
      expectedTaskIds?: ReadonlySet<string>,
    ) {
      const { tasks: taskRows, docs } = window.store.getState();
      const tasks = Object.values(taskRows);
      const staleTaskTitles = expectedTaskIds
        ? [...expectedTaskIds].filter(
            (id) => taskRows[id]?.title !== expectedTitles.get(id),
          ).length
        : tasks.filter(
            ({ _id, title }) => expectedTitles.get(String(_id)) !== title,
          ).length;
      const unexpectedTasks = expectedTaskIds
        ? tasks.filter(({ _id }) => !expectedTaskIds.has(String(_id))).length
        : 0;
      return {
        ...totals,
        refusedScopes: refused.size,
        rows: tasks.length,
        staleDocTitles: [...expectedDocTitles].filter(
          ([id, title]) => docs[id]?.title !== title,
        ).length,
        staleTaskTitles,
        unexpectedTasks,
      };
    },
  };
}
