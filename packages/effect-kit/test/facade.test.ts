import { expect, test } from "bun:test";
import { Service } from "effect/Context";
import {
  acquireRelease,
  andThen,
  onInterrupt,
  promise,
  sync,
} from "effect/Effect";
import { effect, empty } from "effect/Layer";
import { makeFacade } from "@codecast/effect-kit/effect";

test("aborting a call interrupts its running fiber and waits for cleanup", async () => {
  const facade = makeFacade(empty);
  try {
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let interrupted = false;
    const operation = andThen(
      sync(started.resolve),
      promise(() => finish.promise),
    ).pipe(
      onInterrupt(() =>
        sync(() => {
          interrupted = true;
        }),
      ),
    );

    const call = facade.run(operation, controller.signal);
    await started.promise;
    controller.abort();
    finish.resolve();
    await expect(call).rejects.toBeDefined();
    expect(interrupted).toBe(true);
  } finally {
    await facade.dispose();
  }
}, 1_000);

test("calls share one layer scope and disposal releases it once", async () => {
  const Resource = Service<number>("effect-kit/test/Resource");
  const events: string[] = [];
  const facade = makeFacade(
    effect(
      Resource,
      acquireRelease(
        sync(() => {
          events.push("acquired");
          return events.length;
        }),
        () =>
          sync(() => {
            events.push("released");
          }),
      ),
    ),
  );

  try {
    expect(
      await Promise.all([facade.run(Resource), facade.run(Resource)]),
    ).toEqual([1, 1]);
    expect(events).toEqual(["acquired"]);
  } finally {
    await Promise.all([facade.dispose(), facade.dispose()]);
  }
  expect(events).toEqual(["acquired", "released"]);
});
