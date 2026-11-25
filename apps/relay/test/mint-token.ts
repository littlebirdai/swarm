import { createHmac } from "node:crypto";
import type { RelayGrantClaims } from "@codecast/relay-contract";

export function signTestPayload(key: Uint8Array, base64url: string) {
  const message = `v1.${base64url}`;
  const signature = createHmac("sha256", key)
    .update(message)
    .digest("base64url");
  return `${message}.${signature}`;
}

export function mintTestToken(key: Uint8Array, claims: RelayGrantClaims) {
  return signTestPayload(
    key,
    Buffer.from(JSON.stringify(claims)).toString("base64url"),
  );
}
