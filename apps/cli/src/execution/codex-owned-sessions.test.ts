import { expect, test } from "bun:test";
import { STEER_BATON_CAPABILITY } from "@codecast/edge-contract";
import { until } from "../../../../tests/codex-driver-parity/peers.js";
import { fixture, item } from "./codex-owned-pilot-fixture.js";
import { ownsCodexCheckpoint } from "./codex-owned-pilot.js";

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
