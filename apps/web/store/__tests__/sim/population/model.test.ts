import { expect, test } from "bun:test";
import { DURATION_MS, PEAK_START_MS, population } from "./model";

test("the seed reproduces project follows, activity and device order", () => {
  const model = population(42, 50);
  expect(population(42, 50)).toEqual(model);
  expect(population(43, 50).people).not.toEqual(model.people);
  expect(population(43, 50).activity.map(({ at }) => at)).not.toEqual(
    model.activity.map(({ at }) => at),
  );
  expect(new Set(model.deviceOrder.map(({ id }) => id)).size).toBe(50);
});

test("projects cluster by team and most work uses a home project", () => {
  const model = population(42, 500);
  expect(model.teams.map(({ members }) => members.length)).toEqual([
    400, 30, 30, 30, 10,
  ]);
  for (const person of model.people) {
    expect(person.follows.length).toBeGreaterThanOrEqual(1);
    expect(person.follows.length).toBeLessThanOrEqual(4);
    expect(new Set(person.follows).size).toBe(person.follows.length);
    expect(
      person.follows.every(
        (project) => model.projects[project].team === person.team,
      ),
    ).toBe(true);
  }
  const primaryProjects = new Set(
    model.people.map(({ follows }) => follows[0]),
  );
  expect(primaryProjects.size).toBeGreaterThan(30);
  const atHome = model.activity.filter(
    ({ person, project }) => person.follows[0] === project,
  );
  expect(atHome.length / model.activity.length).toBeGreaterThan(0.75);
  expect(atHome.length / model.activity.length).toBeLessThan(0.95);
  const small = population(42, 10);
  for (const person of small.people) {
    expect(new Set(person.follows)).toEqual(
      new Set(small.teams[person.team].projects),
    );
  }
});

test("half of the agents work at about one change per minute with a fivefold peak", () => {
  const { activity, workingAgents } = population(42, 500);
  expect(workingAgents).toBe(1250);
  expect(new Set(activity.map(({ agent }) => agent)).size).toBe(workingAgents);
  const baseline = activity.filter(({ at }) => at < PEAK_START_MS).length;
  const peak = activity.length - baseline;
  const baselinePerMinute = (baseline * 60_000) / PEAK_START_MS / workingAgents;
  const peakPerMinute =
    (peak * 60_000) / (DURATION_MS - PEAK_START_MS) / workingAgents;
  expect(baselinePerMinute).toBeCloseTo(1, 1);
  expect(peakPerMinute / baselinePerMinute).toBeCloseTo(5, 0);
  expect(
    activity.every(
      ({ at }, i) =>
        at >= 0 && at < DURATION_MS && (i === 0 || at >= activity[i - 1].at),
    ),
  ).toBe(true);
  expect(
    activity.every(({ project, person }) => person.follows.includes(project)),
  ).toBe(true);
});
