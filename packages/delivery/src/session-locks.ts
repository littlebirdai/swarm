import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

type SessionLock = {
  readonly semaphore: Semaphore.Semaphore;
  users: number;
};

export function makeSessionLocks() {
  const locks = new Map<string, SessionLock>();

  const acquire = (session: string) =>
    Effect.sync(() => {
      let lock = locks.get(session);
      if (!lock) {
        lock = { semaphore: Semaphore.makeUnsafe(1), users: 0 };
        locks.set(session, lock);
      }
      lock.users += 1;
      return lock;
    });

  const release = (session: string, lock: SessionLock) =>
    Effect.sync(() => {
      lock.users -= 1;
      if (lock.users === 0 && locks.get(session) === lock) {
        locks.delete(session);
      }
    });

  const withSessionLock = <A, E, R>(
    session: string,
    effect: Effect.Effect<A, E, R>,
  ) =>
    Effect.acquireUseRelease(
      acquire(session),
      (lock) => lock.semaphore.withPermit(effect),
      (lock) => release(session, lock),
    );

  return { withSessionLock, size: () => locks.size };
}
