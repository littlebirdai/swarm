import { expect, spyOn, test } from "bun:test";
import { patchEnv } from "@codecast/test-helpers/patchEnv";
import { CI_FLAG_VARS, CI_PRESENCE_VARS } from "@platform/analytics";
import { internal } from "./_generated/api";
import { serverTest } from "../test-helpers/database.testkit";

const env = {
  POSTHOG_KEY: "fixture",
  POSTHOG_HOST: "https://metrics.invalid",
  VITE_POSTHOG_KEY: undefined,
  CODECAST_TELEMETRY_DISABLED: undefined,
  DO_NOT_TRACK: undefined,
  ...Object.fromEntries(
    [...CI_FLAG_VARS, ...CI_PRESENCE_VARS].map((name) => [name, undefined]),
  ),
};

test("samples the oldest pending age as a personless event and reports an empty queue", async () => {
  const restoreEnv = patchEnv(env);
  const payloads: unknown[] = [];
  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    async (url, init) => {
      if (String(url) !== "https://metrics.invalid/i/v0/e/")
        throw new Error("Unexpected analytics URL");
      payloads.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 200 });
    },
  );
  try {
    const t = serverTest();
    const now = Date.now();
    const ids = await t.run(({ db }) =>
      Promise.all(
        [60_000, 180_000].map((age) =>
          db.insert("sync_outbox", {
            scope_key: "user:fixture",
            entity_type: "docs",
            entity_id: String(age),
            revision: 1,
            delivered_revision: 0,
            position: 0,
            pending: true,
            updated_at: now - age,
            op: "upsert",
          }),
        ),
      ),
    );
    await t.action(internal.analytics.sampleSyncOutbox, {});
    await t.run(async ({ db }) => {
      for (const id of ids) await db.delete(id);
    });
    await t.action(internal.analytics.sampleSyncOutbox, {});
    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toMatchObject({
      event: "sync_outbox_status",
      properties: { $process_person_profile: false },
    });
    const pendingAge = (
      payloads[0] as { properties: { oldest_age_ms: number } }
    ).properties.oldest_age_ms;
    expect(pendingAge).toBeGreaterThanOrEqual(180_000);
    expect(pendingAge).toBeLessThanOrEqual(Date.now() - now + 180_000);
    expect(payloads[1]).toMatchObject({
      event: "sync_outbox_status",
      properties: { oldest_age_ms: 0, $process_person_profile: false },
    });
  } finally {
    fetch.mockRestore();
    restoreEnv();
  }
});

test.each([
  ["no key", { POSTHOG_KEY: undefined }],
  ["telemetry opt-out", { DO_NOT_TRACK: "1" }],
] as const)(
  "skips the status read and analytics with %s",
  async (_, overrides) => {
    const restoreEnv = patchEnv({ ...env, ...overrides });
    const fetch = spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("Unexpected analytics request");
    });
    try {
      const t = serverTest({ bytesRead: 1 });
      await t.run(({ db }) =>
        db.insert("sync_outbox", {
          scope_key: "user:fixture",
          entity_type: "docs",
          entity_id: "pending",
          revision: 1,
          delivered_revision: 0,
          position: 0,
          pending: true,
          updated_at: Date.now(),
          op: "upsert",
        }),
      );
      await expect(t.query(internal.syncOutbox.status, {})).rejects.toThrow(
        /limit/i,
      );
      await t.action(internal.analytics.sampleSyncOutbox, {});
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
      restoreEnv();
    }
  },
);
