import {
  makeSimBackend,
  type ScheduledJob,
} from "@codecast/convex/convex/simBackend.testing";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
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
import { populationReplica } from "./replica";
import { fixtureId, populationTables } from "./workload";

const POLL_MS = 1500;
const CONTENTION_WINDOW_MS = 5;

type OutboxSlot = { scope_key: string; updated_at: number; pending: boolean };

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
}) {
  const model = population(config.seed, config.people);
  installRealm(config.seed);
  try {
    const saves = model.activity.length;
    const lag: number[] = [];
    const lastHeadWrite = new Map<string, number>();
    const lastSlotDelivery = new Map<string, number>();
    let modeledRetries = 0;
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
      modules: { population: () => import("./workload") },
      onSchedule: (job: ScheduledJob) => {
        if (job.name !== "syncOutbox:drain")
          throw new Error(`Unexpected job ${job.name}`);
        const isContinuation = job.due === now();
        const { id } = job.args as { id: string };
        net.enqueue("sched", {
          due: job.due,
          label: job.name,
          producer: job.name,
          run: async () => {
            const slot: OutboxSlot | null = await backend.db.get(id);
            if (!slot) throw new Error(`Missing outbox slot ${id}`);
            const { scope_key: scope } = slot;
            if (!isContinuation) {
              const scheduled: { state: { kind: string } } | null =
                await backend.db.system.get(job.id);
              const previous =
                scheduled?.state.kind === "canceled"
                  ? lastSlotDelivery.get(id)
                  : scheduled?.state.kind === "pending" && slot.pending
                    ? lastHeadWrite.get(scope)
                    : undefined;
              if (
                previous !== undefined &&
                now() - previous < CONTENTION_WINDOW_MS
              )
                modeledRetries++;
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
            const headIds = new Set<string>(
              (backend.db._tables.sync_heads ?? []).map(
                (row: { _id: string }) => row._id,
              ),
            );
            const writes =
              backend.db._inserted
                .slice(insertCount)
                .filter((row: { table: string }) => row.table === "sync_heads")
                .length + patches.filter((row) => headIds.has(row._id)).length;
            if (writes) lastHeadWrite.set(scope, now());
            headWrites += writes;
            for (const { _id, patch } of patches) {
              if ("delivered_revision" in patch) {
                const delivered: OutboxSlot = await backend.db.get(_id);
                lastSlotDelivery.set(_id, now());
                lag.push(now() - delivered.updated_at);
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

    const devices = model.deviceOrder
      .slice(0, config.devices)
      .map((person) => populationReplica(backend, person));
    const tasks = new Map<number, Id<"tasks">>();
    for (const event of model.activity) {
      net.enqueue("save", {
        due: T0 + event.at,
        label: "save task",
        producer: "agent",
        run: async () => {
          const task: Id<"tasks"> = await backend.runInternal(
            "population:saveTask",
            {
              ...(tasks.has(event.agent)
                ? { task: tasks.get(event.agent) }
                : {}),
              user: fixtureId("users", event.person.id),
              ...(event.person.team === null
                ? {}
                : { team: fixtureId("teams", event.person.team) }),
              project: fixtureId("projects", event.project),
              agent: event.agent,
              privateTask: event.privateTask,
            },
          );
          tasks.set(event.agent, task);
        },
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
    await net.drain({ horizonMs: DURATION_MS + POLL_MS });
    if (
      net.queued((channel) => !channel.startsWith("timer:")) ||
      backend.db._tables.sync_outbox?.some((slot: OutboxSlot) => slot.pending)
    )
      throw new Error("Population simulation left undelivered work");
    const taskRows: { _id: string; title: string }[] = await backend.db
      .query("tasks")
      .collect();
    const expectedTitles = new Map(
      taskRows.map(({ _id, title }) => [_id, title]),
    );
    const measurements = devices.map((device) => device.result(expectedTitles));
    const baselineSaves = model.activity.filter(
      ({ at }) => at < PEAK_START_MS,
    ).length;
    return {
      ...config,
      devices: devices.length,
      durationMs: DURATION_MS,
      peakStartMs: PEAK_START_MS,
      pollMs: POLL_MS,
      contentionWindowMs: CONTENTION_WINDOW_MS,
      teams: model.teams.length,
      projects: model.projects.length,
      workingAgents: model.workingAgents,
      saves,
      baselineSaves,
      peakSaves: saves - baselineSaves,
      headWrites,
      drainTransactions,
      modeledRetries,
      modeledRetriesPerWrite: saves ? modeledRetries / saves : 0,
      drainLagMs: distribution(lag),
      eventsPerDevice: distribution(measurements.map(({ events }) => events)),
      teamEventsPerDevice: distribution(
        measurements.map(({ teamEvents }) => teamEvents),
      ),
      bytesPerDevice: distribution(measurements.map(({ bytes }) => bytes)),
      rowsPerDevice: distribution(measurements.map(({ rows }) => rows)),
      measurements,
    };
  } finally {
    uninstallRealm();
  }
}
