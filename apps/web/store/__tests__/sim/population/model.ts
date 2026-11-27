import { fnv1a32 } from "@codecast/hash/fnv1a32";
import { makeRng } from "@codecast/inbox/__fixtures__/inboxProjectionGen";

export const DURATION_MS = 60_000;
export const PEAK_START_MS = 48_000;
export const PEAK_MULTIPLIER = 5;
const AGENTS_PER_MEMBER = 5;
const SESSIONS_PER_PERSON = 2;

export type Person = {
  id: number;
  follows: number[];
  followsSessions: number[];
};

export type Session = {
  id: number;
  owner: number;
  project: number;
  active: boolean;
};

export type BackgroundActivity =
  | { at: number; kind: "heartbeat" | "message"; session: Session }
  | { at: number; kind: "doc"; person: Person; project: number };

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
  const backgroundRng = makeRng(fnv1a32(`${seed}:background`));
  const projectCount = Math.ceil(peopleCount / 12);
  const projects = Array.from({ length: projectCount }, (_, id) => id);
  const people = Array.from({ length: peopleCount }, (_, id): Person => {
    const home = Math.floor(graphRng() * projectCount);
    const follows = new Set([home]);
    const extra = 1 + Math.floor(graphRng() * 3);
    for (let i = 0; i < extra; i++) {
      follows.add(Math.floor(graphRng() ** 2 * projectCount));
    }
    return { id, follows: [...follows], followsSessions: [] };
  });
  const sessions = people.flatMap(({ id: owner, follows }) =>
    Array.from({ length: SESSIONS_PER_PERSON }, (_, index): Session => ({
      id: owner * SESSIONS_PER_PERSON + index,
      owner,
      project: follows[0],
      active: index === 0,
    })),
  );
  const activeSessions = sessions.filter(({ active }) => active);
  const sessionsByProject = projects.map((project) =>
    activeSessions.filter((session) => session.project === project),
  );
  for (const person of people) {
    const peers = person.follows
      .flatMap((project) => sessionsByProject[project])
      .filter(({ owner }) => owner !== person.id);
    person.followsSessions = peers
      .map(({ id }, rank) => ({
        id,
        rank: rank / (peers.length + 1) + graphRng(),
      }))
      .sort((a, b) => a.rank - b.rank)
      .slice(0, 2 + Math.floor(graphRng() * 4))
      .map(({ id }) => id);
  }

  const background: BackgroundActivity[] = [];
  for (const session of activeSessions) {
    const firstBeat = Math.floor(backgroundRng() * 30_000);
    for (const offset of [0, 30_000]) {
      background.push({ at: firstBeat + offset, kind: "heartbeat", session });
    }
    const firstMessage = Math.floor(backgroundRng() * PEAK_START_MS);
    background.push({ at: firstMessage, kind: "message", session });
    if (backgroundRng() < 0.35) {
      background.push({
        at:
          PEAK_START_MS +
          Math.floor(backgroundRng() * (DURATION_MS - PEAK_START_MS)),
        kind: "message",
        session,
      });
    }
  }
  for (const person of people) {
    if (person.id === 0 || backgroundRng() < 0.3) {
      const project =
        person.follows[Math.floor(backgroundRng() * person.follows.length)];
      background.push({
        at: Math.floor(backgroundRng() * DURATION_MS),
        kind: "doc",
        person,
        project,
      });
    }
  }

  const agents = people.flatMap((person) =>
    Array.from({ length: AGENTS_PER_MEMBER }, (_, index) => ({
      person,
      agent: person.id * AGENTS_PER_MEMBER + index,
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
  background.sort((a, b) => a.at - b.at);
  return {
    projects,
    people,
    sessions,
    background,
    activity,
    deviceOrder,
    workingAgents: working.length,
  };
}
