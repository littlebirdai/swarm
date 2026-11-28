import { expect, test } from "bun:test";
import { population } from "./model";
import { runPopulation } from "./run";

test.each([1, 50])(
  "all-project subscriptions deliver shared changes without team-wide sync fan-out at %i people",
  async (people) => {
    const seed = 42;
    const model = population(seed, people);
    const report = await runPopulation({
      people,
      devices: people,
      seed,
      mode: "all-projects",
    });
    expect(report.teams).toBe(1);
    expect(report.sessions).toBe(people * 2);
    expect(report.writes.heartbeat).toBe(people * 2);
    expect(report.writes.message).toBeGreaterThanOrEqual(people);
    expect(report.writes.doc).toBeGreaterThan(0);
    const shared = model.activity.filter(({ privateTask }) => !privateTask);
    const sharedTasks = new Set(shared.map(({ agent }) => agent));
    expect(report.scopeWrites).toEqual({
      team: 0,
      user: model.activity.length + report.writes.doc + people,
      interest: shared.length + report.writes.doc,
    });
    expect(report.measurements).toHaveLength(people);
    if (people > 1) {
      expect(
        model.people.some((person) =>
          model.background.some(
            (event) =>
              event.kind === "doc" && !person.follows.includes(event.project),
          ),
        ),
      ).toBe(true);
    }
    for (const device of report.measurements) {
      const own = model.activity.filter(
        ({ person }) => person.id === device.person,
      );
      expect(device.teamEvents).toBe(0);
      expect(device.interestEvents).toBeGreaterThan(0);
      expect(device.eventsByEntity.tasks).toBe(shared.length + own.length);
      expect(device.eventsByEntity.docs).toBeGreaterThan(0);
      if (people === 1 || own.length > 0)
        expect(device.eventsByEntity.conversations).toBeGreaterThan(0);
      expect(device.rows).toBe(
        new Set([...sharedTasks, ...own.map(({ agent }) => agent)]).size,
      );
      expect(device.staleTaskTitles).toBe(0);
      expect(device.staleDocTitles).toBe(0);
    }
  },
  30_000,
);

test("a device sample preserves the write load and each sampled device's results", async () => {
  const config = { people: 10, devices: 10, seed: 23 };
  const full = await runPopulation(config);
  const sample = await runPopulation({ ...config, devices: 3 });
  expect(sample.writes).toEqual(full.writes);
  expect(sample.headWrites).toBe(full.headWrites);
  expect(sample.scopeWrites).toEqual(full.scopeWrites);
  expect(sample.nearbyCanceledDrains).toEqual(full.nearbyCanceledDrains);
  expect(sample.headWritesPerDrain).toBe(full.headWritesPerDrain);
  expect(sample.measurements).toEqual(full.measurements.slice(0, 3));
});

test.each([1, 50])(
  "interest scopes converge followed project work at %i people without team-wide fan-out",
  async (people) => {
    const seed = 42;
    const model = population(seed, people);
    const baseline = await runPopulation({
      people,
      devices: people,
      seed,
      mode: "all-projects",
    });
    const report = await runPopulation({
      people,
      devices: people,
      seed,
      mode: "interest",
    });
    const shared = model.activity.filter(({ privateTask }) => !privateTask);
    expect(report.scopeWrites).toEqual({
      team: 0,
      user: model.activity.length + report.writes.doc + people,
      interest: shared.length + report.writes.doc,
    });
    expect(report.measurements).toHaveLength(people);
    for (const device of report.measurements) {
      expect(device.teamEvents).toBe(0);
      expect(device.staleTaskTitles).toBe(0);
      expect(device.staleDocTitles).toBe(0);
      expect(device.unexpectedTasks).toBe(0);
    }
    if (people > 1) {
      expect(report.eventsPerDevice.mean).toBeLessThan(
        baseline.eventsPerDevice.mean,
      );
      expect(report.interestEventsPerDevice.mean).toBeGreaterThan(0);
    }
  },
  30_000,
);

test.each([1, 50])(
  "realistic simulation exercises multi-team denied rows, cross-project moves, and refused session scopes at %i people",
  async (people) => {
    const seed = 42;
    const baseline = await runPopulation({
      people,
      devices: people,
      seed,
      mode: "all-projects",
      realistic: true,
    });
    const report = await runPopulation({
      people,
      devices: people,
      seed,
      mode: "interest",
      realistic: true,
    });
    expect(report.teams).toBe(people >= 2 ? 2 : 1);
    expect(report.deniedTasks).toBeGreaterThan(0);
    expect(report.scopeWrites.interest).toBeGreaterThan(0);
    for (const device of report.measurements) {
      expect(device.teamEvents).toBe(0);
      expect(device.staleTaskTitles).toBe(0);
      expect(device.staleDocTitles).toBe(0);
      expect(device.unexpectedTasks).toBe(0);
    }
    if (people > 1) {
      expect(report.crossProjectMoves).toBeGreaterThan(0);
      expect(report.refusedScopesPerDevice.mean).toBeGreaterThan(0);
      expect(report.eventsPerDevice.mean).toBeLessThan(
        baseline.eventsPerDevice.mean,
      );
    }
  },
  30_000,
);
