import { createHmac, timingSafeEqual } from "node:crypto";
import { RELAY_MAX_FRAME_BYTES } from "@codecast/relay-contract";
import { TokenVerifier } from "@codecast/relay/effect";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const envelope = /^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/u;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function hmacVerifier(key: Uint8Array, previousKey?: Uint8Array) {
  const verify = (token: string) => {
    const parts = envelope.exec(token);
    if (!parts) return null;
    const [, payload, signature] = parts;
    const supplied = Buffer.from(signature, "base64url");
    if (supplied.toString("base64url") !== signature) return null;
    const matches = (candidate: Uint8Array) =>
      timingSafeEqual(
        createHmac("sha256", candidate).update(`v1.${payload}`).digest(),
        supplied,
      );
    const currentMatches = matches(key);
    const previousMatches = previousKey ? matches(previousKey) : false;
    if (!currentMatches && !previousMatches) return null;
    const bytes = Buffer.from(payload, "base64url");
    if (
      bytes.length > RELAY_MAX_FRAME_BYTES ||
      bytes.toString("base64url") !== payload
    )
      return null;
    try {
      return utf8.decode(bytes);
    } catch {
      return null;
    }
  };
  return Layer.effect(
    TokenVerifier,
    Effect.succeed(TokenVerifier.of({ verify })),
  );
}
