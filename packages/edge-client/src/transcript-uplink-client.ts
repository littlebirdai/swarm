import { setTimeout as delay } from "node:timers/promises";
import {
  TRANSCRIPT_APPEND_OPERATION,
  type TranscriptAppendResult,
  type TranscriptAppendWrite,
} from "@codecast/edge-contract";
import { makeFacade } from "@codecast/effect-kit/effect";
import * as Effect from "effect/Effect";
import { fileTranscriptSpool } from "./transcript-spool";
import {
  TranscriptUplink,
  TranscriptUplinkError,
  type TranscriptSubmission,
} from "./transcript-uplink";

export interface TranscriptUplinkClient {
  start(): Promise<void>;
  submit(write: TranscriptAppendWrite): Promise<TranscriptSubmission>;
  waitForReplay(conversationId: string): Promise<void>;
  close(): Promise<void>;
}

export function createTranscriptUplink(options: {
  spoolPath: string;
  siteUrl: string;
  bearer: () => string | null;
  fallback: (write: TranscriptAppendWrite) => Promise<TranscriptAppendResult>;
}): TranscriptUplinkClient {
  const lifetime = new AbortController();
  const url = new URL(
    `/edge/v1/${TRANSCRIPT_APPEND_OPERATION}`,
    options.siteUrl,
  );
  let rejectedBearer: string | null = null;
  const facade = makeFacade(
    TranscriptUplink.layer({
      spool: fileTranscriptSpool(options.spoolPath),
      fallback: options.fallback,
      async send(batch, signal) {
        let bearer = options.bearer();
        while (!bearer || bearer === rejectedBearer) {
          await delay(1_000, undefined, { signal });
          bearer = options.bearer();
        }
        const response = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${bearer}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(batch),
          signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        });
        if (!response.ok) {
          await response.body?.cancel();
          if (response.status === 401) rejectedBearer = bearer;
          const retryAfterMs =
            Number(response.headers.get("Retry-After")) * 1_000;
          throw new TranscriptUplinkError({
            message:
              response.status === 401
                ? "Authentication failed: invalid transcript device token"
                : `Transcript batch request failed (${response.status})`,
            credentialRejected: response.status === 401,
            retryable: response.status === 429 || response.status >= 500,
            fallbackAllowed: [400, 403, 404, 405, 410, 413, 422].includes(
              response.status,
            ),
            retryAfterMs: Number.isSafeInteger(retryAfterMs)
              ? retryAfterMs
              : undefined,
          });
        }
        return response.json();
      },
    }),
  );
  return {
    start: () =>
      facade.run(
        Effect.flatMap(TranscriptUplink, (uplink) => uplink.ready),
        lifetime.signal,
      ),
    waitForReplay: (conversationId) =>
      facade.run(
        Effect.flatMap(TranscriptUplink, (uplink) =>
          uplink.waitForReplay(conversationId),
        ),
        lifetime.signal,
      ),
    submit: (write) =>
      facade.run(
        Effect.flatMap(TranscriptUplink, (uplink) => uplink.submit(write)),
        lifetime.signal,
      ),
    close: () => {
      lifetime.abort();
      return facade.dispose();
    },
  };
}
