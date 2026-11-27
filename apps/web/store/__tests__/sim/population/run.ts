import {
  makeSimBackend,
  type ScheduledJob,
} from "@codecast/convex/convex/simBackend.testing";
import { Net } from "../net";
import {
  advance,
  attachRealm,
  installRealm,
  now,
  stream,
  T0,
  uninstallRealm,
} from "../realm";
import { DURATION_MS, PEAK_START_MS, population } from "./model";
import { type PopulationMode, populationReplica } from "./replica";
import {
  fixtureId,
  populationTables,
  runBackground,
  saveTask,
} from "./workload";

export type { PopulationMode } from "./replica";

const POLL_MS = 1500;
const CONTENTION_WINDOW_MS = 5;

type OutboxSlot = { scope_key: string; pending: boolean };
type ScopeClass = "team" | "user" | "interest";

function scopeClass(scope: string): ScopeClass {
  if (scope.startsWith("team:")) return "team";
  if (scope.startsWith("user:")) return "user";
  if (
    scope.startsWith("project:") ||
    scope.startsWith("session:") ||
    scope.startsWith("dir:") ||
    scope.startsWith("channel:")
  )
    return "interest";
  throw new Error(`Unexpected sync scope ${scope}`);
}

function ratio(numerator: number, denominator: number) {
  return denominator ? Number((numerator / denominator).toFixed(4)) : 0;
}

function distribution(values: number[]) {
  if (!values.length) return { min: 0, mean: 0, p50: 0, p95: 0, max: 0 };
  const sorted = values.toSorted((a, b) => a - b);
  return {
    min: sorted[0],
    mean: sorted.reduce((sum, number) => sum + number, 0) / sorted.length,
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    max: sorted[sorted.length - 1],
  };
}

export async function runPopulation(config: {
  people: number;
  devices: number;
  seed: number;
  mode?: PopulationMode;
}) {
  const mode: PopulationMode = config.mode ?? "team";
  const model = population(config.seed, config.people);
  const previousInterestScopes = process.env.SWARM_INTEREST_SCOPES;
  if (mode === "interest") process.env.SWARM_INTEREST_SCOPES = "1";
  else delete process.env.SWARM_INTEREST_SCOPES;
  installRealm(config.seed);
  try {
    const writes = {
      task: model.activity.length,
      doc: 0,
      heartbeat: 0,
      message: 0,
    };
    for (const event of model.background) writes[event.kind]++;
    const saves = writes.task + writes.doc + writes.heartbeat + writes.message;
    const drainJobBySlot = new Map<string, string>();
    const deliveryByJob = new Map<string, number>();
    const scopeWrites = { team: 0, user: 0, interest: 0 };
    const nearbyCanceledDrains = { team: 0, user: 0, interest: 0 };
    const headIds = new Set<string>();
    let headWrites = 0;
    let drainTransactions = 0;
    const backend = makeSimBackend({
      tables: populationTables(model, T0),
      now,
      mintId: (table, n) =>
        `popsim${table.replaceAll("_", "")}${n.toString(36).padStart(5, "0")}`.padEnd(
          32,
          "0",
        ),
      rngFor: (seq) => stream(`population:server:${seq}`),
      modules: {
        userSends: () => import("@codecast/convex/convex/userSends"),
      },
      onSchedule: (job: ScheduledJob) => {
        const isContinuation = job.due === now();
        const { id } = job.args as { id: string };
        if (job.name === "syncOutbox:drain") drainJobBySlot.set(id, job.id);
        net.enqueue("sched", {
          due: job.due,
          label: job.name,
          producer: job.name,
          run: async () => {
            if (job.name !== "syncOutbox:drain") {
              const callCount = backend.calls.length;
              await backend.runScheduled(job);
              const call = backend.calls[callCount];
              if (call && !call.ok) throw new Error(call.error ?? job.name);
              return;
            }
            const slot: OutboxSlot | null = await backend.db.get(id);
            if (!slot) throw new Error(`Missing outbox slot ${id}`);
            const { scope_key: scope } = slot;
            if (!isContinuation) {
              const scheduled: { state: { kind: string } } | null =
                await backend.db.system.get(job.id);
              const previous =
                scheduled?.state.kind === "canceled"
                  ? deliveryByJob.get(job.id)
                  : undefined;
              if (
                previous !== undefined &&
                now() - previous < CONTENTION_WINDOW_MS
              )
                nearbyCanceledDrains[scopeClass(scope)]++;
            }
            const callCount = backend.calls.length;
            const patchCount: number = backend.db._patched.length;
            const insertCount: number = backend.db._inserted.length;
            await backend.runScheduled(job);
            const call = backend.calls[callCount];
            if (!call) return;
            if (!call.ok) throw new Error(call.error ?? "Outbox drain failed");
            drainTransactions++;
            const patches: { _id: string; patch: Record<string, unknown> }[] =
              backend.db._patched.slice(patchCount);
            for (const insert of backend.db._inserted.slice(insertCount)) {
              if (insert.table === "sync_heads") {
                headIds.add(insert._id);
                headWrites++;
              }
            }
            for (const { _id, patch } of patches) {
              if (headIds.has(_id)) headWrites++;
              if ("delivered_revision" in patch) {
                const deliveredJob = drainJobBySlot.get(_id);
                if (deliveredJob) deliveryByJob.set(deliveredJob, now());
              }
            }
          },
        });
      },
    });
    const net = new Net({
      now,
      advance,
      rng: stream("population:net"),
      writes: backend.writes,
      maxDeliveries: saves * 8 + 2_000,
      maxWrites: saves * 30 + 2_000,
    });
    attachRealm({ timers: net, serverCall: backend.activeCall });

    const sampledPeople = model.deviceOrder.slice(0, config.devices);
    const devices = sampledPeople.map((person) =>
      populationReplica(backend, person, mode),
    );
    const clients = model.people.map(({ id }) =>
      backend.clientFor({ kind: "user", userId: fixtureId("users", id) }),
    );
    async function measureWrite(write: () => Promise<void>) {
      const patchCount = backend.db._patched.length;
      const insertCount = backend.db._inserted.length;
      await write();
      const scopes = new Set<string>();
      for (const { table, doc } of backend.db._inserted.slice(insertCount)) {
        if (table === "sync_outbox") scopes.add(doc.scope_key);
      }
      for (const { _id, patch } of backend.db._patched.slice(patchCount)) {
        if (
          patch.pending === true &&
          typeof patch.scope_key === "string" &&
          backend.db.normalizeId("sync_outbox", _id)
        )
          scopes.add(patch.scope_key);
      }
      for (const scope of scopes) scopeWrites[scopeClass(scope)]++;
    }

    for (const event of model.background) {
      net.enqueue("background", {
        due: T0 + event.at,
        label: event.kind,
        producer: "population",
        run: () =>
          measureWrite(() =>
            runBackground(
              clients[
                event.kind === "doc" ? event.person.id : event.session.owner
              ],
              event,
            ),
          ),
      });
    }
    const tasks = new Map<number, string>();
    for (const event of model.activity) {
      net.enqueue("save", {
        due: T0 + event.at,
        label: "save task",
        producer: "agent",
        run: () =>
          measureWrite(async () => {
            const shortId = await saveTask(
              clients[event.person.id],
              event,
              tasks.get(event.agent),
            );
            tasks.set(event.agent, shortId);
          }),
      });
    }
    for (let at = 0; at <= DURATION_MS + POLL_MS; at += POLL_MS) {
      net.enqueue("poll", {
        due: T0 + at,
        label: "sync log poll",
        producer: "replica",
        run: async () => {
          for (const device of devices) await device.poll();
        },
      });
    }
    await net.drain({ horizonMs: 2 * DURATION_MS + POLL_MS });
    if (
      net.queued((channel) => !channel.startsWith("timer:")) ||
      backend.db._tables.sync_outbox?.some((slot: OutboxSlot) => slot.pending)
    )
      throw new Error("Population simulation left undelivered work");
    const taskRows: {
      _id: string;
      title: string;
      user_id: string;
      project_id?: string;
      workspace: string;
    }[] = await backend.db.query("tasks").collect();
    const expectedTitles = new Map(
      taskRows.map(({ _id, title }) => [_id, title]),
    );
    const expectedDocTitles = new Map<string, string>();
    const docUpdateAuthors = new Map<number, number>();
    for (const event of model.background) {
      if (event.kind === "doc") {
        expectedDocTitles.set(
          fixtureId("docs", event.project),
          `Project ${event.project} notes at ${event.at}`,
        );
        docUpdateAuthors.set(event.project, event.person.id);
      }
    }
    const teamWorkspace = `team:${fixtureId("teams", 0)}`;
    const measurements = devices.map((device, index) => {
      if (mode !== "interest")
        return device.result(expectedTitles, expectedDocTitles);
      const person = sampledPeople[index];
      const userId = String(fixtureId("users", person.id));
      const followedProjects = new Set(
        person.follows.map((project) => String(fixtureId("projects", project))),
      );
      const expectedTaskIds = new Set(
        taskRows
          .filter(
            (task) =>
              task.user_id === userId ||
              (task.workspace === teamWorkspace &&
                task.project_id !== undefined &&
                followedProjects.has(String(task.project_id))),
          )
          .map(({ _id }) => _id),
      );
      const followedDocs = new Map(
        [...expectedDocTitles].filter(([docId]) => {
          const projectIndex = person.follows.find(
            (project) => String(fixtureId("docs", project)) === docId,
          );
          if (projectIndex !== undefined) return true;
          for (const [project, authorId] of docUpdateAuthors) {
            if (
              authorId === person.id &&
              String(fixtureId("docs", project)) === docId
            )
              return true;
          }
          return false;
        }),
      );
      return device.result(expectedTitles, followedDocs, expectedTaskIds);
    });
    const baselineSaves = [...model.activity, ...model.background].filter(
      ({ at }) => at < PEAK_START_MS,
    ).length;
    const scopeWriteSummary: {
      team: number;
      user: number;
      interest?: number;
    } =
      mode === "interest"
        ? scopeWrites
        : { team: scopeWrites.team, user: scopeWrites.user };
    const canceledDrainSummary: {
      team: number;
      user: number;
      interest?: number;
    } =
      mode === "interest"
        ? nearbyCanceledDrains
        : { team: nearbyCanceledDrains.team, user: nearbyCanceledDrains.user };
    const heuristicRetriesSummary: {
      team: number;
      user: number;
      interest?: number;
    } = {
      team: ratio(nearbyCanceledDrains.team, scopeWrites.team),
      user: ratio(nearbyCanceledDrains.user, scopeWrites.user),
      ...(mode === "interest"
        ? {
            interest: ratio(
              nearbyCanceledDrains.interest,
              scopeWrites.interest,
            ),
          }
        : {}),
    };
    return {
      ...config,
      mode,
      devices: devices.length,
      durationMs: DURATION_MS,
      peakStartMs: PEAK_START_MS,
      pollMs: POLL_MS,
      contentionWindowMs: CONTENTION_WINDOW_MS,
      teams: 1,
      sessions: model.sessions.length,
      writes,
      projects: model.projects.length,
      workingAgents: model.workingAgents,
      saves,
      baselineSaves,
      peakSaves: saves - baselineSaves,
      headWrites,
      drainTransactions,
      headWritesPerDrain: ratio(headWrites, drainTransactions),
      scopeWrites: scopeWriteSummary,
      nearbyCanceledDrains: canceledDrainSummary,
      heuristicRetriesPerScopeWrite: heuristicRetriesSummary,
      eventsPerDevice: distribution(measurements.map(({ events }) => events)),
      teamEventsPerDevice: distribution(
        measurements.map(({ teamEvents }) => teamEvents),
      ),
      interestEventsPerDevice: distribution(
        measurements.map(({ interestEvents }) => interestEvents),
      ),
      bytesPerDevice: distribution(measurements.map(({ bytes }) => bytes)),
      rowsPerDevice: distribution(measurements.map(({ rows }) => rows)),
      measurements,
    };
  } finally {
    if (previousInterestScopes === undefined)
      delete process.env.SWARM_INTEREST_SCOPES;
    else process.env.SWARM_INTEREST_SCOPES = previousInterestScopes;
    uninstallRealm();
  }
}
