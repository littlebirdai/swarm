import { expect, test } from "bun:test";
import { DURATION_MS, PEAK_START_MS, population } from "./model";

test("the seed reproduces project and session follows, activity and device order", () => {
  const model = population(42, 50);
  expect(population(42, 50)).toEqual(model);
  expect(population(43, 50).people).not.toEqual(model.people);
  expect(population(43, 50).background).not.toEqual(model.background);
  expect(new Set(model.deviceOrder.map(({ id }) => id)).size).toBe(50);
});

test("members follow a few projects and active peer sessions in those projects", () => {
  const model = population(42, 500);
  const followedProjects = new Set<number>();
  const followedSessions = new Set<number>();
  for (const person of model.people) {
    const own = model.sessions.filter(({ owner }) => owner === person.id);
    expect(own.map(({ active }) => active)).toEqual([true, false]);
    expect(person.follows.length).toBeGreaterThanOrEqual(1);
    expect(person.follows.length).toBeLessThanOrEqual(4);
    expect(person.followsSessions.length).toBeGreaterThanOrEqual(2);
    expect(person.followsSessions.length).toBeLessThanOrEqual(5);
    for (const id of person.follows) followedProjects.add(id);
    for (const id of person.followsSessions) {
      const session = model.sessions[id];
      expect(session.owner).not.toBe(person.id);
      expect(session.active).toBe(true);
      expect(person.follows).toContain(session.project);
      followedSessions.add(id);
    }
  }
  expect(followedProjects.size).toBeGreaterThan(30);
  expect(followedSessions.size).toBeGreaterThan(250);
  expect(population(42, 1).people[0].followsSessions).toEqual([]);
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
  const home = activity.filter(
    ({ project, person }) => person.follows[0] === project,
  );
  expect(home.length / activity.length).toBeGreaterThan(0.75);
  expect(home.length / activity.length).toBeLessThan(0.95);
});
