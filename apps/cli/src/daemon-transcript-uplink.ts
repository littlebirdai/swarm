import { createHash } from "node:crypto";
import { join } from "node:path";
import { createTranscriptUplink } from "@codecast/edge-client";
import type { SyncService } from "./syncService.js";

export function openTranscriptUplink(
  sync: SyncService,
  options: {
    convexUrl: string;
    configDir: string;
    account: string;
    machine: string;
    bearer: () => string | null;
  },
) {
  return createTranscriptUplink({
    siteUrl: options.convexUrl.replace(".cloud", ".site"),
    spoolPath: join(
      options.configDir,
      "transcript-uplink",
      createHash("sha256")
        .update(
          JSON.stringify([options.convexUrl, options.account, options.machine]),
        )
        .digest("hex") + ".json",
    ),
    bearer: options.bearer,
    fallback: (write) => {
      const bearer = options.bearer();
      if (!bearer) throw new Error("Transcript device credentials unavailable");
      return sync.replayTranscriptWrite(write, bearer);
    },
  });
}
