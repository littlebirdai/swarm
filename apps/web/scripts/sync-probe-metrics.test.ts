import { expect, test } from "bun:test";
import { syncProbeAnalytics } from "./sync-probe-metrics";

const optedIn = {
  CODECAST_SYNC_PROBE_METRICS: "1",
  POSTHOG_KEY: "fixture",
  POSTHOG_HOST: "https://metrics.invalid",
};

test("publishes both percentiles as a personless probe metric", async () => {
  const requests: Array<{ url: string; body: unknown }> = [];
  const capture = (async (
    url: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  const metrics = syncProbeAnalytics(optedIn, capture);
  await metrics.capturePersonless("sync_save_to_screen", {
    samples: 30,
    p50_ms: 32.4,
    p95_ms: 46.2,
  });
  expect(requests).toEqual([
    {
      url: "https://metrics.invalid/i/v0/e/",
      body: {
        api_key: "fixture",
        event: "sync_save_to_screen",
        distinct_id: expect.any(String),
        properties: {
          source: "sync_probe",
          samples: 30,
          p50_ms: 32.4,
          p95_ms: 46.2,
          $process_person_profile: false,
        },
      },
    },
  ]);
});

test("requires an opt-in and honors telemetry opt-out", () => {
  expect(() => syncProbeAnalytics({ POSTHOG_KEY: "fixture" })).toThrow(
    "CODECAST_SYNC_PROBE_METRICS=1",
  );
  expect(() =>
    syncProbeAnalytics({ ...optedIn, CODECAST_TELEMETRY_DISABLED: "1" }),
  ).toThrow("telemetry is disabled");
});
