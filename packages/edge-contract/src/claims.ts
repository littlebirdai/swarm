import {
  count,
  nonEmptyString,
  object,
  oneOf,
  parser,
  responseObject,
  positiveInteger,
  tagged,
} from "./parse";
import { readV1 } from "./version";
import { response } from "./response";
import { daemon } from "./link";

const session = nonEmptyString;
export const claimScope = { session, run: positiveInteger };
export const fence = { ...claimScope, fencing_token: nonEmptyString };

const claimRequest = object({
  v: readV1,
  session,
  ...daemon,
  claim_id: nonEmptyString,
});
const claimResponse = response(
  tagged("status", {
    granted: responseObject({
      v: readV1,
      status: oneOf("granted"),
      ...fence,
      lease_ms: positiveInteger,
      last_pane_instance: count,
    }),
    busy: responseObject({
      v: readV1,
      status: oneOf("busy"),
      retry_after_ms: count,
    }),
    stale: responseObject({ v: readV1, status: oneOf("stale") }),
  }),
);
const renewRequest = object({ v: readV1, ...fence });
const renewResponse = response(
  tagged("status", {
    renewed: responseObject({
      v: readV1,
      status: oneOf("renewed"),
      lease_ms: positiveInteger,
    }),
    stale: responseObject({ v: readV1, status: oneOf("stale") }),
  }),
);
const releaseRequest = object({ v: readV1, ...fence });
const releaseResponse = response(
  responseObject({ v: readV1, status: oneOf("released", "stale") }),
);

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
