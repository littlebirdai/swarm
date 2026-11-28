import type {
  ProviderDeliverInput,
  SupervisorBus,
} from "@codecast/edge-supervisor/effect";
import * as Effect from "effect/Effect";
import { DeliveryError, mapBusError, requestId } from "./journals";
import type { DeliveryOptions, DeliveryPermit } from "./types";

export function makeInputPreparation(
  bus: SupervisorBus["Service"],
  options: DeliveryOptions,
) {
  return Effect.fnUntraced(function* (
    permit: DeliveryPermit,
    parts: DeliveryPermit["input"],
  ) {
    const prepared: ProviderDeliverInput[] = [];
    for (const part of parts) {
      if (part.type === "text") {
        const text = options.prepareText
          ? yield* Effect.tryPromise({
              try: (signal) => options.prepareText!(part.text, permit, signal),
              catch: (cause) =>
                new DeliveryError({
                  operation: "blobs.get",
                  code: "input_preparation_failed",
                  retryable: true,
                  cause,
                }),
            })
          : part.text;
        prepared.push({ type: "text", text });
        continue;
      }
      const reqId = requestId();
      const blobReply = yield* bus
        .request(
          {
            kind: "edge.blob.get",
            request_id: reqId,
            request: {
              v: 1,
              session: permit.session,
              run: permit.run,
              fencing_token: permit.fencing_token,
              attempt_id: permit.attempt_id,
              blob_id: part.blob_id,
            },
          },
          "edge.blob.get.result",
          (reply) => reply.request_id === reqId,
        )
        .pipe(Effect.mapError((error) => mapBusError("blobs.get", error)));
      if (!blobReply.ok) {
        return yield* new DeliveryError({
          operation: "blobs.get",
          code: blobReply.code,
          retryable: blobReply.retryable,
          retry_after_ms: blobReply.retry_after_ms,
        });
      }
      if (blobReply.content_type !== part.content_type) {
        return yield* new DeliveryError({
          operation: "blobs.get",
          code: "blob_content_type_mismatch",
          retryable: false,
        });
      }
      if (!options.saveBlob) {
        return yield* new DeliveryError({
          operation: "blobs.get",
          code: "blob_storage_unavailable",
          retryable: true,
        });
      }
      const localPath = yield* Effect.tryPromise({
        try: (signal) =>
          options.saveBlob!(
            permit,
            prepared.length,
            blobReply.content_type,
            blobReply.bytes,
            signal,
          ),
        catch: (cause) =>
          new DeliveryError({
            operation: "blobs.get",
            code: "blob_save_failed",
            retryable: true,
            cause,
          }),
      });
      prepared.push({ type: "local-image", path: localPath });
    }
    return prepared;
  });
}
