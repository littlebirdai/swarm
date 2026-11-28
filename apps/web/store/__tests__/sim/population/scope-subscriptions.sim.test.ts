import { expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import { makeSimBackend } from "@codecast/convex/convex/simBackend.testing";
import {
  floorScopeKeys,
  floorScopesStamped,
} from "../../../../hooks/useBootstrapCollection";
import { catchUp } from "../../../../hooks/use-sync-change-feed";
import { initialScopeSubscriptionState } from "../../../scope-subscriptions";
import { Net } from "../net";
import {
  T0,
  advance,
  attachRealm,
  createWindowStore,
  installRealm,
  now,
  runInWindow,
  stream,
  uninstallRealm,
} from "../realm";
import { DURATION_MS, population } from "./model";
import { runPopulation } from "./run";
import {
  fixtureId,
  populationTables,
  runBackground,
  saveTask,
} from "./workload";

const POLL_MS = 1500;

async function runWithScopeManager(config: {
  people: number;
  devices: number;
  seed: number;
}) {
  const model = population(config.seed, config.people);
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
    const backend = makeSimBackend({
      tables: populationTables(model, T0, { realistic: false }),
      now,
      mintId: (table, n) =>
        `popsim${table.replaceAll("_", "")}${n.toString(36).padStart(5, "0")}`.padEnd(
          32,
          "0",
        ),
      rngFor: (seq) => stream(`scope-sim:server:${seq}`),
      modules: {
        userSends: () => import("@codecast/convex/convex/userSends"),
      },
      onSchedule: (job) => {
        net.enqueue("sched", {
          due: job.due,
          label: job.name,
          producer: job.name,
          run: async () => {
            const callCount = backend.calls.length;
            await backend.runScheduled(job);
            const call = backend.calls[callCount];
            if (call && !call.ok) throw new Error(call.error ?? job.name);
          },
        });
      },
    });
    const net = new Net({
      now,
      advance,
      rng: stream("scope-sim:net"),
      writes: backend.writes,
      maxDeliveries: saves * 8 + 2_000,
      maxWrites: saves * 30 + 2_000,
    });
    attachRealm({ timers: net, serverCall: backend.activeCall });

    const team0 = String(fixtureId("teams", 0));
    const projectMap: Record<string, any> = {};
    for (const project of model.projects) {
      const pid = String(fixtureId("projects", project));
      projectMap[pid] = { _id: pid, workspace: `team:${team0}` };
    }
    const sampledPeople = model.deviceOrder.slice(0, config.devices);
    const devices = sampledPeople.map((person) => {
      const name = `scope-sim-${person.id}`;
      const win = { name, store: createWindowStore(name) };
      win.store.setState({
        syncRole: "host",
        clientStateInitialized: true,
        currentUser: { _id: fixtureId("users", person.id) } as any,
        teams: [{ _id: team0 }] as any,
        projects: projectMap,
        scopeSubscriptions: initialScopeSubscriptionState(),
        clientState: {
          ui: {
            sidebar_pins: person.follows.map((p) => ({
              kind: "project",
              id: String(fixtureId("projects", p)),
            })),
          },
        } as any,
      });
      const client = backend.clientFor({
        kind: "user",
        userId: fixtureId("users", person.id),
      });
      const totals = { events: 0, teamEvents: 0 };
      const meter = {
        async query(ref: any, args: Record<string, unknown>) {
          const result = await client.query(ref, args);
          const fn = getFunctionName(ref);
          if (fn === "syncLog:getRange") {
            totals.events += result.actions.length;
            if (String(args.scope_key).startsWith("team:")) {
              totals.teamEvents += result.actions.length;
            }
          }
          return result;
        },
      };
      return {
        person,
        win,
        async poll() {
          await runInWindow(win, async () => {
            win.store.getState().reconcileScopeSubscriptions(now());
            const chunks = win.store.getState().scopeSubscriptions.chunks;
            for (const chunk of chunks) {
              if (!chunk.length) continue;
              await catchUp(meter, undefined, { scopes: chunk });
            }
          });
        },
        result(
          expectedTitles: ReadonlyMap<string, string>,
          expectedDocTitles: ReadonlyMap<string, string>,
          expectedTaskIds: ReadonlySet<string>,
        ) {
          const s = win.store.getState();
          const { tasks: taskRows, docs } = s;
          const tasks = Object.values(taskRows);
          const teamFloorReady = floorScopesStamped(
            s,
            floorScopeKeys(
              { workspace: "team", team_id: team0 },
              String(fixtureId("users", person.id)),
            ),
          );
          const excludeTombstones = Object.values(s.pending).filter(
            (e: any) => e?.type === "exclude",
          ).length;
          return {
            ...totals,
            teamFloorReady,
            excludeTombstones,
            staleTaskTitles: [...expectedTaskIds].filter(
              (id) => taskRows[id]?.title !== expectedTitles.get(id),
            ).length,
            staleDocTitles: [...expectedDocTitles].filter(
              ([id, title]) => docs[id]?.title !== title,
            ).length,
            unexpectedTasks: tasks.filter(
              ({ _id }) => !expectedTaskIds.has(String(_id)),
            ).length,
          };
        },
      };
    });

    const clients = model.people.map(({ id }) =>
      backend.clientFor({ kind: "user", userId: fixtureId("users", id) }),
    );
    for (const event of model.background) {
      net.enqueue("background", {
        due: T0 + event.at,
        label: event.kind,
        producer: "population",
        run: () =>
          runBackground(
            clients[
              event.kind === "doc" ? event.person.id : event.session.owner
            ],
            event,
          ),
      });
    }
    const tasks = new Map<number, string>();
    for (const event of model.activity) {
      net.enqueue("save", {
        due: T0 + event.at,
        label: "save task",
        producer: "agent",
        run: async () => {
          const existing = tasks.get(event.agent);
          const shortId = await saveTask(
            clients[event.person.id],
            event,
            existing,
          );
          tasks.set(event.agent, shortId);
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
    await net.drain({ horizonMs: 2 * DURATION_MS + POLL_MS });
    const taskRows: any[] = await backend.db.query("tasks").collect();
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
    const teamWorkspace = `team:${team0}`;
    const measurements = devices.map((device) => {
      const userId = String(fixtureId("users", device.person.id));
      const followedProjects = new Set(
        device.person.follows.map((p) => String(fixtureId("projects", p))),
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
          const projectIndex = device.person.follows.find(
            (project) => String(fixtureId("docs", project)) === docId,
          );
          if (projectIndex !== undefined) return true;
          for (const [project, authorId] of docUpdateAuthors) {
            if (
              authorId === device.person.id &&
              String(fixtureId("docs", project)) === docId
            ) {
              return true;
            }
          }
          return false;
        }),
      );
      return device.result(expectedTitles, followedDocs, expectedTaskIds);
    });
    const meanEvents =
      measurements.reduce((sum, m) => sum + m.events, 0) / measurements.length;
    return { measurements, meanEvents };
  } finally {
    uninstallRealm();
  }
}

test("client scope subscription manager drives real reconcile and catchUp in population sim", async () => {
  const people = 50;
  const seed = 42;
  const baselineAllProjects = await runPopulation({
    people,
    devices: people,
    seed,
    mode: "all-projects",
  });
  const baselineInterest = await runPopulation({
    people,
    devices: people,
    seed,
    mode: "interest",
  });
  const managed = await runWithScopeManager({
    people,
    devices: people,
    seed,
  });

  for (const m of managed.measurements) {
    expect(m.teamEvents).toBe(0);
    expect(m.teamFloorReady).toBe(true);
    expect(m.excludeTombstones).toBe(0);
    expect(m.staleTaskTitles).toBe(0);
    expect(m.staleDocTitles).toBe(0);
    expect(m.unexpectedTasks).toBe(0);
  }
  expect(managed.meanEvents).toBe(baselineInterest.eventsPerDevice.mean);
  expect(managed.meanEvents).toBeLessThan(
    baselineAllProjects.eventsPerDevice.mean,
  );
}, 30_000);
