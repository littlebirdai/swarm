import { expect, test } from "bun:test";
import { Service } from "effect/Context";
import { TaggedError } from "effect/Data";
import {
  acquireRelease,
  andThen,
  die,
  fail,
  fn,
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
    const cleanupStarted = Promise.withResolvers<void>();
    const finishCleanup = Promise.withResolvers<void>();
    let settled = false;
    const operation = andThen(
      sync(started.resolve),
      promise(() => finish.promise),
    ).pipe(
      onInterrupt(() =>
        andThen(
          sync(cleanupStarted.resolve),
          promise(() => finishCleanup.promise),
        ),
      ),
    );

    const call = facade.run(operation, controller.signal);
    const outcome = call.then(
      () => {
        settled = true;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await started.promise;
    controller.abort();
    finish.resolve();
    try {
      await Promise.race([
        cleanupStarted.promise,
        outcome.then(() => {
          throw new Error("Call settled before interruption cleanup started");
        }),
      ]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
    } finally {
      finishCleanup.resolve();
    }
    expect(await outcome).toEqual(
      new Error("All fibers interrupted without error"),
    );
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

test.each([
  ["cold, sync", false, "sync"],
  ["cold, async", false, "async"],
  ["warm, sync", true, "sync"],
  ["warm, async", true, "async"],
] as const)(
  "an aborted call skips layer and operation (%s)",
  async (_label, warm, kind) => {
    const Resource = Service<string>("effect-kit/test/Abort");
    let builds = 0;
    let operations = 0;
    const facade = makeFacade(
      effect(
        Resource,
        sync(() => {
          builds++;
          return "ready";
        }),
      ),
    );

    try {
      if (warm) expect(await facade.run(Resource)).toBe("ready");
      const operation = () => {
        operations++;
      };
      const controller = new AbortController();
      controller.abort(new Error("caller reason"));
      await expect(
        facade.run(
          kind === "sync" ? sync(operation) : promise(async () => operation()),
          controller.signal,
        ),
      ).rejects.toEqual(new Error("All fibers interrupted without error"));
      expect(builds).toBe(warm ? 1 : 0);
      expect(operations).toBe(0);
    } finally {
      await facade.dispose();
    }
  },
);

test("dispose interrupts an active call before releasing its layer", async () => {
  const Resource = Service<string>("effect-kit/test/Dispose");
  const events: string[] = [];
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const facade = makeFacade(
    effect(
      Resource,
      acquireRelease(
        sync(() => "ready"),
        () =>
          sync(() => {
            events.push("released");
          }),
      ),
    ),
  );
  const operation = andThen(
    Resource,
    andThen(
      sync(started.resolve),
      promise(() => finish.promise),
    ),
  ).pipe(
    onInterrupt(() =>
      sync(() => {
        events.push("interrupted");
      }),
    ),
  );
  const call = facade.run(operation);
  const outcome = call.then(
    () => undefined,
    (error: unknown) => error,
  );
  try {
    await started.promise;
    const disposing = facade.dispose();
    finish.resolve();
    await disposing;
    expect(await outcome).toEqual(
      new Error("All fibers interrupted without error"),
    );
    expect(events).toEqual(["interrupted", "released"]);
  } finally {
    finish.resolve();
    await facade.dispose();
  }
});

test("typed failures and defects reject with their original values", async () => {
  const facade = makeFacade(empty);
  try {
    const failure = { _tag: "Unavailable" } as const;
    const defect = new TypeError("invalid delivery");
    await expect(facade.run(fail(failure))).rejects.toBe(failure);
    await expect(facade.run(die(defect))).rejects.toBe(defect);
  } finally {
    await facade.dispose();
  }
});

test("a rejected facade call retains the application stack frame", async () => {
  const facade = makeFacade(empty);
  try {
    const outcome = await facade
      .run(
        sync(function submitDelivery() {
          throw new Error("invalid delivery");
        }),
      )
      .catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).stack).toContain("submitDelivery");
    expect((outcome as Error).stack).toContain("facade.test.ts:");
  } finally {
    await facade.dispose();
  }
});

test.each(["tagged failure", "defect"] as const)(
  "an async Effect function chain keeps both span names on the original %s",
  async (kind) => {
    class DeliveryFailure extends TaggedError("DeliveryFailure")<{
      readonly message: string;
    }> {}
    const error =
      kind === "tagged failure"
        ? new DeliveryFailure({ message: "delivery failed" })
        : new TypeError("unexpected delivery value");
    const facade = makeFacade(empty);
    const send = fn("Delivery.send")(function* () {
      yield* promise(() => Promise.resolve());
      return yield* kind === "tagged failure" ? fail(error) : die(error);
    });
    const submit = fn("Dispatch.submit")(function* () {
      return yield* send();
    });
    try {
      await expect(facade.run(submit())).rejects.toBe(error);
      expect(error).toBeInstanceOf(
        kind === "tagged failure" ? DeliveryFailure : TypeError,
      );
      expect(error.stack).toContain("Delivery.send");
      expect(error.stack).toContain("Dispatch.submit");
    } finally {
      await facade.dispose();
    }
  },
);

test("a read-only error stack preserves the rejected defect", async () => {
  const error = new TypeError("read-only stack");
  const stack = error.stack;
  Object.defineProperty(error, "stack", { value: stack, writable: false });
  const facade = makeFacade(empty);
  try {
    await expect(facade.run(die(error))).rejects.toBe(error);
    expect(error.stack).toBe(stack);
  } finally {
    await facade.dispose();
  }
});

test("an abort inside cold layer acquisition prevents the operation from starting", async () => {
  const controller = new AbortController();
  const Resource = Service<string>("effect-kit/test/ColdAbort");
  const events: string[] = [];
  const facade = makeFacade(
    effect(
      Resource,
      sync(() => {
        events.push("acquired");
        controller.abort();
        return "ready";
      }),
    ),
  );
  try {
    await expect(
      facade.run(
        andThen(
          Resource,
          sync(() => {
            events.push("started");
          }),
        ),
        controller.signal,
      ),
    ).rejects.toEqual(new Error("All fibers interrupted without error"));
    expect(events).toEqual(["acquired"]);
  } finally {
    await facade.dispose();
  }
});
