import { expect, spyOn, test } from "bun:test";
import { STEER_BATON_CAPABILITY } from "@codecast/edge-contract";
import { until } from "../../../../tests/codex-driver-parity/peers.js";
import { parkingMemoryRoots, sampleParkingMemory } from "../memory-parking.js";
import { fixture, item } from "./codex-owned-pilot-fixture.js";
import {
  type CodexOwnedPilot,
  ownsCodexCheckpoint,
} from "./codex-owned-pilot.js";

test("a registered boot owns two Codex sessions and leaves an unmarked session on the legacy driver", async () => {
  const f = fixture(null, true, "receipt", true);
  try {
    f.pilotRequest.requiredCapabilities = f.newRequest.requiredCapabilities;
    f.initial([
      item(f.pilotRequest),
      item(f.newRequest),
      item(f.legacyRequest),
    ]);
    await f.runtime.start();
    expect(f.logs).toEqual([]);

    expect(f.bootRegistrations).toEqual([
      expect.objectContaining({ owned_codex_new_sessions: true }),
    ]);
    expect(
      f.workSubscription().args.owned_codex_conversation_id,
    ).toBeUndefined();
    expect(f.workSubscription().args.owned_codex_new_sessions).toBe(true);
    expect(f.permitSessions).toContain("pilot");
    expect(f.permitSessions).toContain("new");
    expect(f.permitSessions).not.toContain("legacy");
    expect(ownsCodexCheckpoint(f.ready(f.pilotRequest).handle)).toBe(true);
    expect(ownsCodexCheckpoint(f.ready(f.newRequest).handle)).toBe(true);
    expect(f.ready(f.newRequest).capabilities).toContain(
      STEER_BATON_CAPABILITY,
    );
    expect(f.actions).toContain("legacy-start:legacy:1");
    expect(f.actions).toContain("legacy-deliver:legacy:1:1");
    const child = f.pilot.pilotFor(f.pilotRequest);
    const binding = f.ready(f.pilotRequest);
    await f.driver.stop(binding);
    expect(f.releasedSessions).toEqual(["pilot"]);
    expect(child?.ownsThread(binding.runtimeId)).toBe(false);
    const next = f.pilot.pilotFor(f.pilotRequest);
    expect(next).toBeDefined();
    expect(next).not.toBe(child);
    f.permitSessions.length = 0;
    await f.runtime.processWorkUpdate([
      item(f.newRequest, f.ready(f.newRequest)),
    ]);
    expect(f.permitSessions).toEqual(["new"]);
  } finally {
    await f.dispose();
  }
});

test("a lease loss on the original pilot leaves the second Codex session able to read permits", async () => {
  const f = fixture("pilot", true, "receipt", true);
  const renewal = Promise.withResolvers<void>();
  f.rejectRenewalAfter(renewal.promise);
  try {
    f.initial([item(f.pilotRequest), item(f.newRequest)]);
    await f.runtime.start();
    expect(f.logs).toEqual([]);

    renewal.resolve();
    await until(
      () => f.releasedSessions.includes("pilot"),
      "the expired session releases its runtime",
    );
    expect(f.releasedSessions).toEqual(["pilot"]);
    f.permitSessions.length = 0;
    await f.runtime.processWorkUpdate([
      item(f.pilotRequest, f.ready(f.pilotRequest)),
      item(f.newRequest, f.ready(f.newRequest)),
    ]);
    expect(f.permitSessions).toEqual(["new"]);
  } finally {
    renewal.resolve();
    await f.dispose();
  }
});

test("without the many-session flag the configured pilot leaves other Codex sessions on legacy", async () => {
  const f = fixture("pilot", true, "receipt");
  try {
    f.initial([item(f.pilotRequest), item(f.legacyRequest)]);
    await f.runtime.start();
    expect(f.logs).toEqual([]);

    expect(f.workSubscription().args).not.toHaveProperty(
      "owned_codex_new_sessions",
    );
    expect(f.permitSessions).toContain("pilot");
    expect(f.actions).toContain("legacy-start:legacy:1");
    expect(f.driver.capabilities).not.toContain(STEER_BATON_CAPABILITY);
  } finally {
    await f.dispose();
  }
});

test("memory parking counts every live owned Codex child process without marking them parkable", async () => {
  const f = fixture(null, true, "receipt", true);
  try {
    f.pilotRequest.requiredCapabilities = f.newRequest.requiredCapabilities;
    f.initial([item(f.pilotRequest), item(f.newRequest)]);
    await f.runtime.start();

    const first = f.ready(f.pilotRequest);
    const second = f.ready(f.newRequest);
    const firstPid = f.pilot.pilotFor(f.pilotRequest)?.getProcessId();
    const secondPid = f.pilot.pilotFor(f.newRequest)?.getProcessId();
    expect(firstPid).toBeNumber();
    expect(secondPid).toBeNumber();
    expect(firstPid).not.toBe(secondPid);
    expect(f.pilot.getProcessId()).toBeUndefined();
    expect(f.pilot.getProcessIds().sort((a, b) => a - b)).toEqual(
      [firstPid!, secondPid!].sort((a, b) => a - b),
    );

    const legacyPid = 900_001;
    expect(f.pilot.ownsThread(first.runtimeId)).toBe(true);
    expect(f.pilot.ownsThread(second.runtimeId)).toBe(true);
    const memory = await sampleParkingMemory(
      100 * 1024,
      parkingMemoryRoots(new Map([["legacy", { pid: legacyPid }]]), f.pilot),
      () => {},
      async () => `${firstPid} 1 45\n${secondPid} 1 50\n${legacyPid} 1 20`,
    );
    expect(memory?.usedBytes).toBe(115 * 1024);
    expect([...(memory?.rssBySession ?? [])]).toEqual([["legacy", 20 * 1024]]);

    await f.driver.stop(first);
    expect(f.pilot.getProcessIds()).toEqual([secondPid!]);
    await f.driver.stop(second);
    expect(f.pilot.getProcessIds()).toEqual([]);
  } finally {
    await f.dispose();
  }
});

test.each(["online", "offline"])(
  "an explicit resume reattaches the ready checkpoint once without restarting a sibling after an %s release",
  async (network) => {
    const f = fixture("pilot", true, "receipt", true);
    const retryAfterMs = 1_337;
    const schedule = globalThis.setTimeout;
    const retries: (() => void)[] = [];
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      const handle = schedule(callback, delay, ...args);
      if (delay === retryAfterMs) {
        clearTimeout(handle);
        retries.push(() => callback(...args));
      }
      return handle;
    }) as typeof setTimeout);
    try {
      f.initial([item(f.newRequest), item(f.pilotRequest)]);
      await f.runtime.start();
      const ready = f.ready(f.newRequest);
      const sibling = f.ready(f.pilotRequest);
      if (network === "offline") {
        const release = Promise.withResolvers<void>();
        f.pauseRelease(release.promise);
        const stopped = f.driver.stop(ready);
        await f.releasing.promise;
        release.reject(new Error("offline"));
        await stopped;
        expect(f.logs).toContain(
          "[owned-codex] lease release failed: Error: offline",
        );
        f.pauseRelease(Promise.resolve());
        f.claimResponses.push(
          Response.json({ v: 1, status: "busy", retry_after_ms: retryAfterMs }),
        );
      } else {
        await f.driver.stop(ready);
      }
      f.permitSessions.length = 0;
      await f.runtime.processWorkUpdate([item(f.newRequest, ready)]);
      expect(f.permitSessions).toEqual([]);

      const resumed = { ...item(f.newRequest, ready), resumeGeneration: 1 };
      await f.runtime.processWorkUpdate([resumed]);
      if (network === "offline") {
        expect(f.permitSessions).toEqual([]);
        expect(retries).toHaveLength(1);
        retries[0]!();
        await f.runtime.processWorkUpdate([]);
      }
      expect(f.permitSessions).toEqual(["new", "new"]);
      expect(f.ready(f.newRequest)).toEqual(ready);
      expect(f.ready(f.pilotRequest)).toEqual(sibling);

      await f.driver.stop(ready);
      f.permitSessions.length = 0;
      await f.runtime.processWorkUpdate([
        resumed,
        item(f.pilotRequest, sibling),
      ]);
      expect(f.permitSessions).toEqual(["pilot"]);
      expect(f.releasedSessions).toEqual(["new", "new"]);
    } finally {
      timer.mockRestore();
      await f.dispose();
    }
  },
);

function cleanupHandles(pilot: CodexOwnedPilot) {
  return pilot as unknown as {
    session: import("@codecast/provider-adapter").ProviderOwnedSession;
    adapter: import("@codecast/provider-adapter").ProviderAdapterClient;
    delivery: { clearImages(): Promise<void> };
  };
}

test("an unconfirmed child stays quarantined until its provider process is gone", async () => {
  const f = fixture(null, true, "receipt", true);
  try {
    await f.runtime.processWorkUpdate([item(f.newRequest)]);
    const binding = f.ready(f.newRequest);
    const child = f.pilot.pilotFor(f.newRequest)!;
    const { session, adapter, delivery } = cleanupHandles(child);
    const dispose = adapter.dispose.bind(adapter);
    const close = spyOn(session, "close").mockRejectedValue(
      new Error("provider close rejected"),
    );
    const attemptedDisposal = spyOn(adapter, "dispose").mockRejectedValue(
      new Error("dispose rejected"),
    );
    const images = spyOn(delivery, "clearImages");
    try {
      await expect(f.driver.stop(binding)).rejects.toThrow(
        "cleanup could not be confirmed",
      );
      expect(attemptedDisposal).toHaveBeenCalledTimes(1);
      expect(images).toHaveBeenCalledTimes(1);
      expect(f.pilot.pilotFor(f.newRequest)).toBe(child);
      expect(f.releasedSessions).toEqual([]);
      const claims = f.actions.filter((action) => action === "edge:claim");
      const resumed = { ...item(f.newRequest, binding), resumeGeneration: 1 };
      await f.runtime.processWorkUpdate([resumed]);
      expect(f.actions.filter((action) => action === "edge:claim")).toEqual(
        claims,
      );
      expect(f.releasedSessions).toEqual([]);

      await dispose();
      expect(session.processGone?.()).toBe(true);
      await f.runtime.processWorkUpdate([resumed]);
      expect(f.releasedSessions).toEqual(["new"]);
      expect(f.pilot.pilotFor(f.newRequest)).not.toBe(child);
      expect(
        f.actions.filter((action) => action === "edge:claim"),
      ).toHaveLength(claims.length + 1);
    } finally {
      close.mockRestore();
      attemptedDisposal.mockRestore();
      images.mockRestore();
      await dispose();
    }
  } finally {
    await f.dispose();
  }
});

test.each(["adapter", "images"])(
  "confirmed provider stop releases its lease even if %s cleanup throws",
  async (failingStep) => {
    const f = fixture(null, true, "receipt", true);
    try {
      await f.runtime.processWorkUpdate([item(f.newRequest)]);
      const child = f.pilot.pilotFor(f.newRequest)!;
      const { adapter, delivery } = cleanupHandles(child);
      const dispose = adapter.dispose.bind(adapter);
      const adapterCleanup = spyOn(adapter, "dispose");
      const images = spyOn(delivery, "clearImages");
      try {
        if (failingStep === "adapter") {
          adapterCleanup.mockImplementation(async () => {
            await dispose();
            throw new Error("adapter disposal failed");
          });
        } else {
          images.mockImplementation(() => {
            throw new Error("image cleanup failed");
          });
        }
        await f.driver.stop(f.ready(f.newRequest));
        expect(adapterCleanup).toHaveBeenCalledTimes(1);
        expect(images).toHaveBeenCalledTimes(1);
        expect(f.releasedSessions).toEqual(["new"]);
        expect(f.pilot.pilotFor(f.newRequest)).not.toBe(child);
      } finally {
        images.mockRestore();
        adapterCleanup.mockRestore();
      }
    } finally {
      await f.dispose();
    }
  },
);

test("an explicit resume backs off after two busy lease responses", async () => {
  const f = fixture(null, true, "receipt", true);
  const schedule = globalThis.setTimeout;
  const retryAfterMs = 1_337;
  const retries: { delay: number; run(): void }[] = [];
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    const handle = schedule(callback, delay, ...args);
    if (delay === retryAfterMs || delay === retryAfterMs * 2) {
      clearTimeout(handle);
      retries.push({ delay, run: () => callback(...args) });
    }
    return handle;
  }) as typeof setTimeout);
  try {
    await f.runtime.processWorkUpdate([item(f.newRequest)]);
    const binding = f.ready(f.newRequest);
    await f.driver.stop(binding);
    f.permitSessions.length = 0;
    for (let i = 0; i < 2; i++) {
      f.claimResponses.push(
        Response.json({ v: 1, status: "busy", retry_after_ms: retryAfterMs }),
      );
    }
    const work = [{ ...item(f.newRequest, binding), resumeGeneration: 1 }];
    await f.runtime.processWorkUpdate(work);
    expect(retries.map(({ delay }) => delay)).toEqual([retryAfterMs]);
    const claims = f.actions.filter((action) => action === "edge:claim");
    await f.runtime.processWorkUpdate(work);
    expect(f.actions.filter((action) => action === "edge:claim")).toEqual(
      claims,
    );
    retries[0]!.run();
    await f.runtime.processWorkUpdate([]);
    expect(retries.map(({ delay }) => delay)).toEqual([
      retryAfterMs,
      retryAfterMs * 2,
    ]);
    expect(f.permitSessions).toEqual([]);
    retries[1]!.run();
    await f.runtime.processWorkUpdate([]);
    expect(f.permitSessions).toEqual(["new", "new"]);
  } finally {
    timer.mockRestore();
    await f.dispose();
  }
});
