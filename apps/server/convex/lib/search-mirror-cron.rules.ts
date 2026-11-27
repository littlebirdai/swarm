import type { cronJobs } from "convex/server";
import { internal } from "../_generated/api";

export function searchMirrorBackoffEnabled() {
  return process.env.SEARCH_MIRROR_CRON_BACKOFF === "1";
}

export function registerSearchMirrorCron(crons: ReturnType<typeof cronJobs>) {
  if (searchMirrorBackoffEnabled())
    crons.interval(
      "advance search mirror",
      { minutes: 1 },
      internal.searchMirror.advanceCron,
      {},
    );
  else
    crons.interval(
      "advance search mirror",
      { seconds: 15 },
      internal.searchMirror.advance,
      { batch: 1000 },
    );
}
