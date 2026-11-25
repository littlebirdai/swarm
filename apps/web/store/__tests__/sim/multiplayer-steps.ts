import { isDeepStrictEqual } from "node:util";
import type { ScenarioWorld } from "./dsl";
import type { MultiplayerSession, Person } from "./multiplayer-contract";

export function enqueue(
  world: ScenarioWorld,
  source: string,
  label: string,
  run: () => void,
) {
  world.net.enqueue(`multiplayer:${source}`, {
    label,
    producer: source,
    run,
  });
}

export async function deliver(
  world: ScenarioWorld,
  source: string,
  label: string,
  run: () => void,
) {
  enqueue(world, source, label, run);
  await world.net.drain();
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

export function sendFrom(
  session: MultiplayerSession,
  id: string,
  from: Person,
  turn: string | null,
  text = id,
) {
  session.press({ id, from, text, expected: { kind: "turn", turn } });
  session.start(id);
}

export function handToAgent(session: MultiplayerSession, id: string) {
  session.hand(id);
  session.land(id);
  session.settleDelivery(id);
}
