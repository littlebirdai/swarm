import { count, nonEmptyString, object, oneOf, parser, positiveInteger, tagged } from "./parse";
import { readV1 } from "./version";
import { daemon } from "./link";

export const claimScope = { session: nonEmptyString, run: positiveInteger };
export const fence = { ...claimScope, fencing_token: nonEmptyString };

const claimRequest = object({
  v: readV1,
  ...claimScope,
  ...daemon,
  claim_id: nonEmptyString,
});
const claimResponse = tagged("status", {
  granted: object({
    v: readV1,
    status: oneOf("granted"),
    ...fence,
    expires_at: count,
  }),
  busy: object({ v: readV1, status: oneOf("busy") }),
  stale: object({ v: readV1, status: oneOf("stale") }),
});
const renewRequest = object({ v: readV1, ...fence });
const renewResponse = tagged("status", {
  renewed: object({ v: readV1, status: oneOf("renewed"), expires_at: count }),
  stale: object({ v: readV1, status: oneOf("stale") }),
});
const releaseRequest = object({ v: readV1, ...fence });
const releaseResponse = object({ v: readV1, status: oneOf("released", "stale") });

export type ClaimRequest = ReturnType<typeof claimRequest>;
export type ClaimResponse = ReturnType<typeof claimResponse>;
export type RenewRequest = ReturnType<typeof renewRequest>;
export type RenewResponse = ReturnType<typeof renewResponse>;
export type ReleaseRequest = ReturnType<typeof releaseRequest>;
export type ReleaseResponse = ReturnType<typeof releaseResponse>;

export const parseClaimRequest = parser(claimRequest);
export const parseClaimResponse = parser(claimResponse);
export const parseRenewRequest = parser(renewRequest);
export const parseRenewResponse = parser(renewResponse);
export const parseReleaseRequest = parser(releaseRequest);
export const parseReleaseResponse = parser(releaseResponse);
