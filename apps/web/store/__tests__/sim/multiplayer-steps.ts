import { isDeepStrictEqual } from "node:util";
import type { ScenarioWorld } from "./dsl";
import type {
  MultiplayerSession,
  Outcome,
  Permit,
  Person,
  Prompt,
  Send,
  Started,
  Wire,
} from "./multiplayer-contract";
import { advance } from "./realm";
import { fakeMultiplayerSession } from "./multiplayer-fake";

export function withMultiplayerSession(
  run: (world: ScenarioWorld, session: MultiplayerSession) => Promise<void>,
) {
  return (world: ScenarioWorld) => {
    const wire: Wire = (channel, label, act) =>
      new Promise((resolve, reject) => {
        world.net.enqueue(`multiplayer:${channel}`, {
          label,
          producer: channel,
          run: () => {
            try {
              resolve(act());
            } catch (error) {
              reject(error);
            }
          },
        });
      });
    return run(world, fakeMultiplayerSession(wire, Date.now, advance));
  };
}

export async function observe<T>(
  world: ScenarioWorld,
  work: Promise<T>,
): Promise<T> {
  await world.net.drain();
  return work;
}

export function check(
  world: ScenarioWorld,
  id: string,
  meaning: string,
  actual: unknown,
  expected: unknown,
) {
  if (isDeepStrictEqual(actual, expected)) return;
  world.fail({
    ...world.reportBase(meaning),
    invariant: { id: `multiplayer.${id}`, meaning },
    message: `Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
  });
}

export function send(
  id: string,
  from: Person,
  turn: string | null | undefined,
  intent: Send["intent"] = "steer",
  text = id,
): Send {
  return {
    id,
    from,
    text,
    intent,
    expected: turn === undefined ? undefined : { kind: "turn", turn },
  };
}

export function permitOf(result: Started | Outcome): Permit {
  if (typeof result === "string")
    throw new Error(`Expected a permit, received ${result}`);
  return result.permit;
}

export async function handToAgent(session: MultiplayerSession, permit: Permit) {
  await session.receivePermit(permit);
  return session.hand(permit);
}

export async function complete(session: MultiplayerSession, permit: Permit) {
  const hand = await handToAgent(session, permit);
  const outcome = hand === "handed" ? await session.land(permit) : hand;
  return session.settle(permit, outcome);
}

export async function sendToAgent(session: MultiplayerSession, input: Send) {
  const outcome = await complete(
    session,
    permitOf(await session.submit(input)),
  );
  await session.publishTurn();
  return outcome;
}

export async function refresh(session: MultiplayerSession, person: Person) {
  await Promise.all([
    session.receiveDurable(person),
    session.receiveRelay(person),
  ]);
  return session.view(person);
}

export function question(run: number, prompt_id: string): Prompt {
  return {
    run,
    opened: { prompt_id, kind: "question", summary: "Choose the report title" },
    verifiedKind: "question",
  };
}
