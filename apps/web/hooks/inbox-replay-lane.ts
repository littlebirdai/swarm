type SnapshotCoverage = { position: number; ids: ReadonlySet<string> };
type ReplayLane = { tail: Promise<void>; snapshot?: SnapshotCoverage };

type ReplayAccount = {
  controller: AbortController;
  scopes: Map<string, ReplayLane>;
};

const clients = new WeakMap<object, ReplayAccount>();

function accountFor(client: object): ReplayAccount {
  let account = clients.get(client);
  if (!account) {
    account = { controller: new AbortController(), scopes: new Map() };
    clients.set(client, account);
  }
  return account;
}

export function inboxReplaySignal(client: object): AbortSignal {
  return accountFor(client).controller.signal;
}

export function resetInboxReplayLanes(client: object): void {
  const account = clients.get(client);
  clients.delete(client);
  account?.controller.abort();
}

export function checkReplaySignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason;
}

export function awaitReplayResult<T>(
  result: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  let abort: () => void;
  return new Promise<T>((resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void result.then(resolve, reject);
    if (signal.aborted) abort();
  }).finally(() => signal.removeEventListener("abort", abort));
}

export async function withReplayTimeout<T>(
  parent: AbortSignal,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  checkReplaySignal(parent);
  const controller = new AbortController();
  const abort = () => controller.abort(parent.reason);
  parent.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error("Sync replay timed out")),
    20_000,
  );
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
    parent.removeEventListener("abort", abort);
  }
}

function laneFor(client: object, scope: string): ReplayLane {
  const { scopes } = accountFor(client);
  let lane = scopes.get(scope);
  if (!lane) scopes.set(scope, (lane = { tail: Promise.resolve() }));
  return lane;
}

export function withInboxReplayLane<T>(
  client: object,
  scope: string,
  request: AbortSignal,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const account = inboxReplaySignal(client);
  const controller = new AbortController();
  const abortRequest = () => controller.abort(request.reason);
  const abortAccount = () => controller.abort(account.reason);
  request.addEventListener("abort", abortRequest, { once: true });
  account.addEventListener("abort", abortAccount, { once: true });
  if (request.aborted) abortRequest();
  if (account.aborted) abortAccount();
  const { signal } = controller;
  const lane = laneFor(client, scope);
  const result = lane.tail.then(() => {
    checkReplaySignal(signal);
    return run(signal);
  });
  lane.tail = result.then(
    () => undefined,
    () => undefined,
  );
  return awaitReplayResult(result, signal).finally(() => {
    request.removeEventListener("abort", abortRequest);
    account.removeEventListener("abort", abortAccount);
  });
}

export function inboxSnapshotCoverage(client: object, scope: string) {
  return clients.get(client)?.scopes.get(scope)?.snapshot;
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
  const lane = clients.get(client)?.scopes.get(scope);
  if (lane?.snapshot && lane.snapshot.position <= position)
    delete lane.snapshot;
}
