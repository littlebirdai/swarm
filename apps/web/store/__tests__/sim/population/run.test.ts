import { expect, test } from "bun:test";
import { population } from "./model";
import { runPopulation } from "./run";

test.each([1, 50])(
  "the team-wide baseline delivers shared changes at %i people",
  async (people) => {
    const seed = 42;
    const model = population(seed, people);
    const report = await runPopulation({ people, devices: people, seed });
    expect(report.teams).toBe(1);
    expect(report.sessions).toBe(people * 2);
    expect(report.writes.heartbeat).toBe(people * 2);
    expect(report.writes.message).toBeGreaterThanOrEqual(people);
    expect(report.writes.doc).toBeGreaterThan(0);
    const shared = model.activity.filter(({ privateTask }) => !privateTask);
    const sharedTasks = new Set(shared.map(({ agent }) => agent));
    const sharedChanges = report.measurements[0].teamEvents;
    expect(sharedChanges).toBeGreaterThan(shared.length);
    expect(report.scopeWrites).toEqual({
      team: shared.length + report.writes.doc,
      user: model.activity.length + report.writes.doc + people,
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
      expect(report.headWritesPerDrain).toBeGreaterThan(1);
      expect(report.heuristicRetriesPerScopeWrite.team).toBeGreaterThan(
        report.heuristicRetriesPerScopeWrite.user,
      );
    }
    for (const device of report.measurements) {
      const own = model.activity.filter(
        ({ person }) => person.id === device.person,
      );
      expect(device.teamEvents).toBe(sharedChanges);
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
