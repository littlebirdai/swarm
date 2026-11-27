type SnapshotCoverage = { position: number; ids: ReadonlySet<string> };
type ReplayLane = { tail: Promise<void>; snapshot?: SnapshotCoverage };

const clients = new WeakMap<object, Map<string, ReplayLane>>();

function laneFor(client: object, scope: string): ReplayLane {
  let scopes = clients.get(client);
  if (!scopes) clients.set(client, (scopes = new Map()));
  let lane = scopes.get(scope);
  if (!lane) scopes.set(scope, (lane = { tail: Promise.resolve() }));
  return lane;
}

export function withInboxReplayLane<T>(
  client: object,
  scope: string,
  run: () => Promise<T>,
): Promise<T> {
  const lane = laneFor(client, scope);
  const result = lane.tail.then(run);
  lane.tail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function inboxSnapshotCoverage(client: object, scope: string) {
  return clients.get(client)?.get(scope)?.snapshot;
}

export function coverInboxSnapshot(
  client: object,
  scope: string,
  position: number,
  ids: Iterable<string>,
) {
  laneFor(client, scope).snapshot = { position, ids: new Set(ids) };
}

export function retireInboxSnapshot(
  client: object,
  scope: string,
  position: number,
) {
  const lane = clients.get(client)?.get(scope);
  if (lane?.snapshot && lane.snapshot.position <= position)
    delete lane.snapshot;
}
