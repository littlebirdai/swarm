import { expect, test } from "bun:test";
import { population } from "./model";
import { runPopulation } from "./run";

test("every device receives one event per eligible scope and holds its visible tasks", async () => {
  const config = { people: 10, devices: 10, seed: 23 };
  const report = await runPopulation(config);
  const { activity, people } = population(config.seed, config.people);
  const shared = activity.filter(({ privateTask }) => !privateTask);
  expect(shared.length).toBeLessThan(activity.length);
  expect(shared.length).toBeGreaterThan(0);
  expect(report.saves).toBe(activity.length);
  expect(report.drainLagMs.max).toBe(25);
  for (const device of report.measurements) {
    const teamEvents = shared.filter(
      ({ person }) => person.team === device.team,
    );
    const personalEvents = activity.filter(
      ({ person }) => person.id === device.person,
    );
    expect(device.teamEvents).toBe(teamEvents.length);
    expect(device.events).toBe(teamEvents.length + personalEvents.length);
    expect(device.rangeBytes).toBeGreaterThan(device.events);
    expect(device.bytes).toBeGreaterThan(device.rangeBytes);
    expect(device.rows).toBe(
      new Set([...teamEvents, ...personalEvents].map(({ agent }) => agent))
        .size,
    );
    expect(people[device.person].team).toBe(device.team);
  }
  expect(report.headWrites).toBe(activity.length + shared.length);
});

test("a device sample preserves all write load and the exact results for sampled devices", async () => {
  const config = { people: 10, devices: 10, seed: 23 };
  const full = await runPopulation(config);
  const sample = await runPopulation({ ...config, devices: 3 });
  expect(sample.saves).toBe(full.saves);
  expect(sample.headWrites).toBe(full.headWrites);
  expect(sample.modeledRetries).toBe(full.modeledRetries);
  expect(sample.drainLagMs).toEqual(full.drainLagMs);
  expect(sample.measurements).toEqual(full.measurements.slice(0, 3));
});
