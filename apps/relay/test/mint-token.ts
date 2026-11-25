import { createHmac } from "node:crypto";
import type { RelayGrantClaims } from "@codecast/relay-contract";

export function mintTestToken(key: Uint8Array, claims: RelayGrantClaims) {
  const message = `v1.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
  const signature = createHmac("sha256", key)
    .update(message)
    .digest("base64url");
  return `${message}.${signature}`;
}
