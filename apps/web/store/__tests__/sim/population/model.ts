import { fnv1a32 } from "@codecast/hash/fnv1a32";
import { makeRng } from "@codecast/inbox/__fixtures__/inboxProjectionGen";

export const DURATION_MS = 60_000;
export const PEAK_START_MS = 48_000;
export const PEAK_MULTIPLIER = 5;
const AGENTS_PER_PERSON = 5;

export type Person = {
  id: number;
  team: number;
  follows: number[];
};

export type Activity = {
  at: number;
  person: Person;
  agent: number;
  project: number;
  privateTask: boolean;
};

export function population(seed: number, peopleCount: number) {
  const graphRng = makeRng(fnv1a32(`${seed}:graph`));
  const activityRng = makeRng(fnv1a32(`${seed}:activity`));
  const sampleRng = makeRng(fnv1a32(`${seed}:sample`));
  const mainTeamSize = Math.ceil(peopleCount * 0.8);
  const teamOf = (id: number) =>
    id < mainTeamSize ? 0 : 1 + Math.floor((id - mainTeamSize) / 30);
  const teams = Array.from(
    { length: teamOf(peopleCount - 1) + 1 },
    (_, id) => ({
      id,
      members: [] as number[],
      projects: [] as number[],
    }),
  );
  for (let id = 0; id < peopleCount; id++) teams[teamOf(id)].members.push(id);
  const projects = teams.flatMap((team) =>
    Array.from(
      { length: Math.max(1, Math.ceil(team.members.length / 12)) },
      () => ({ team: team.id }),
    ),
  );
  projects.forEach(({ team }, id) => teams[team].projects.push(id));

  const people = Array.from({ length: peopleCount }, (_, id): Person => {
    const team = teamOf(id);
    const available = teams[team].projects;
    const home = available[Math.floor(graphRng() * available.length)];
    const follows = new Set([home]);
    if (peopleCount < 50) {
      for (const project of available) follows.add(project);
    } else {
      const extra = 1 + Math.floor(graphRng() * 3);
      for (let i = 0; i < extra; i++) {
        follows.add(available[Math.floor(graphRng() ** 2 * available.length)]);
      }
    }
    return { id, team, follows: [...follows] };
  });

  const agents = people.flatMap((person) =>
    Array.from({ length: AGENTS_PER_PERSON }, (_, index) => ({
      person,
      agent: person.id * AGENTS_PER_PERSON + index,
      rank: activityRng(),
    })),
  );
  const working = agents
    .sort((a, b) => a.rank - b.rank)
    .slice(0, Math.ceil(agents.length / 2));
  const activity = working.flatMap(({ person, agent }): Activity[] => {
    const project =
      person.follows[
        activityRng() < 0.75
          ? 0
          : Math.floor(activityRng() * person.follows.length)
      ];
    const privateTask = activityRng() < 0.1;
    const phases = [
      { start: 0, end: PEAK_START_MS, speed: 1 },
      { start: PEAK_START_MS, end: DURATION_MS, speed: PEAK_MULTIPLIER },
    ];
    return phases.flatMap(({ start, end, speed }) => {
      const interval = 60_000 / speed;
      const events: Activity[] = [];
      for (
        let at = start + Math.floor(activityRng() * interval);
        at < end;
        at += interval
      ) {
        events.push({ at, person, agent, project, privateTask });
      }
      return events;
    });
  });
  activity.sort((a, b) => a.at - b.at || a.agent - b.agent);
  const deviceOrder = people
    .map((person) => ({ person, rank: sampleRng() }))
    .sort((a, b) => a.rank - b.rank)
    .map(({ person }) => person);
  return {
    teams,
    projects,
    people,
    activity,
    deviceOrder,
    workingAgents: working.length,
  };
}
