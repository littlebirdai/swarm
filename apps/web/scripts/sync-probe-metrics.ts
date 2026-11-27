import { CODECAST_EVENTS, TELEMETRY_DISABLED_VAR } from "@codecast/analytics";
import { createServerAnalytics } from "@platform/analytics/server";

export function syncProbeAnalytics(
  env: Record<string, string | undefined>,
  fetchCapture: typeof fetch = fetch,
) {
  if (env.CODECAST_SYNC_PROBE_METRICS !== "1")
    throw new Error(
      "Set CODECAST_SYNC_PROBE_METRICS=1 to publish probe metrics",
    );
  const posthogKey = env.POSTHOG_KEY || env.VITE_POSTHOG_KEY;
  if (!posthogKey) throw new Error("The sync probe requires POSTHOG_KEY");
  const analytics = createServerAnalytics({
    posthogKey,
    posthogHost: env.POSTHOG_HOST,
    source: "sync_probe",
    catalog: CODECAST_EVENTS,
    env,
    optOutVars: [TELEMETRY_DISABLED_VAR],
    fetch: (url, init) =>
      fetchCapture(url, { ...init, signal: AbortSignal.timeout(5000) }),
  });
  if (analytics.optedOut) throw new Error("Sync probe telemetry is disabled");
  return analytics;
}
