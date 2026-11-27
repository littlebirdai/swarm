import {
  TRANSCRIPT_APPEND_OPERATION,
  type TranscriptAppendResult,
  type TranscriptAppendWrite,
} from "@codecast/edge-contract";
import { makeFacade } from "@codecast/effect-kit/effect";
import * as Effect from "effect/Effect";
import { fileTranscriptSpool } from "./transcript-spool";
import { TranscriptUplink, TranscriptUplinkError } from "./transcript-uplink";

export interface TranscriptUplinkClient {
  start(): Promise<void>;
  submit(
    write: TranscriptAppendWrite,
    signal?: AbortSignal,
  ): Promise<TranscriptAppendResult>;
  close(): Promise<void>;
}

export function createTranscriptUplink(options: {
  spoolPath: string;
  siteUrl: string;
  bearer: () => string | null;
}): TranscriptUplinkClient {
  const lifetime = new AbortController();
  const url = new URL(
    `/edge/v1/${TRANSCRIPT_APPEND_OPERATION}`,
    options.siteUrl,
  );
  const facade = makeFacade(
    TranscriptUplink.layer({
      spool: fileTranscriptSpool(options.spoolPath),
      async send(batch, signal) {
        const bearer = options.bearer();
        if (!bearer)
          throw new TranscriptUplinkError({
            message:
              "Authentication failed: transcript device credentials unavailable",
            retryable: false,
          });
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
          const retryAfterMs =
            Number(response.headers.get("Retry-After")) * 1_000;
          throw new TranscriptUplinkError({
            message:
              response.status === 401
                ? "Authentication failed: invalid transcript device token"
                : `Transcript batch request failed (${response.status})`,
            retryable: response.status === 429 || response.status >= 500,
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
    submit: (write, signal) =>
      facade.run(
        Effect.flatMap(TranscriptUplink, (uplink) => uplink.submit(write)),
        signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal,
      ),
    close: () => {
      lifetime.abort();
      return facade.dispose();
    },
  };
}
