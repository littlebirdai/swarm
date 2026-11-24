# codecast edge/v1

This is the JSON contract between the codecast daemon and server. Import it from
`@codecast/shared/contracts/edge/v1`. Each verb has request and response parsers.
They return the parsed value or an `EdgeParseError` with a field path and code.

## Versions and compatibility

`hello` selects the highest shared version. If every offered version is newer
than the server supports, it returns `server_behind`. Other failures to agree
return `upgrade_required`. The server supports the newest released version and
the previous one when both exist. Versioned messages carry `v: 1`.

The v1 requests and the meaning of its responses freeze on release. The server
rejects unknown request fields, including nested fields in fixed wire objects.
The daemon validates known response fields and ignores added fields, including
policy settings. This lets the server add optional response fields and policy
settings in v1. A changed request, a changed response field, or a new response
variant requires v2.

## Backpressure and limits

Any verb can return an error with `v`, `status: "error"`, `code`, `retryable`,
and an optional `retry_after_ms`. A retryable error can carry a minimum wait
before the daemon tries again. `EDGE_ERROR_CODES` names the codes defined by
v1. The server can add codes within v1. The daemon treats unfamiliar codes as
opaque strings and still uses `retryable` and `retry_after_ms`.

Policy sets the uplink interval and caps the event count and encoded request
size for one append. It also caps the decoded size of one blob. The server
enforces these limits. The wire parsers validate the policy without applying it.

## Events and claims

Each event carries a session ID, a run epoch, and a sequence number for that
session. Sequence numbers are positive safe integers and continue across run
epochs. Timestamps and expirations use Unix time in milliseconds. A null
`turn` means the event has no associated turn.

One append can carry several event groups. Each group has one session, epoch,
and fencing token. The events in a group are contiguous. The server returns one
result per group, in request order. A gap reports the next expected sequence
number. A conflict reports the sequence number of a stored event with different
content. A stale claim affects only its own group.

The live transcript relay channel carries `message.delta`. The delta offset
counts UTF-16 code units from the start of the message. Deltas use the same
`message_id` as the final assistant event and do not consume a durable
sequence number.

The server assigns the run epoch and grants a fencing token. The daemon sends
the token with event groups, inbox writes, claim renewals and releases, and
results for commands that carry a claim. The server checks the current claim
and its expiry before it accepts a claimed write. The daemon reuses its
`claim_id` when it retries the same acquisition request.

## Blobs

`blobs.put` carries the lowercase hexadecimal SHA-256 digest of the decoded
bytes. The server verifies the digest and uses it to return the same blob ID
for repeated uploads within the caller's authorized storage scope.

A tool result wraps inline JSON in `{ "inline": … }` or uses
`{ "blob_id": "…" }` for a blob reference. Inline JSON can contain its own
`blob_id` field. User events can include references in `attachments`.
A delivery permit can carry text and blob parts in order. Each blob part
supplies the content type.

## Delivery policy

The server supplies the effective intent on each permit. An agent sender
queues by default. The server can issue steer after the session owner grants
it to that sender.

The permit's `seq` orders deliveries within the session. The daemon echoes
the permit fields, including `attempt_id`. A permit marked `started` or a
start response of `already_started` requires recovery before another effect.
The daemon checks the transcript for the original effect. If the result is
uncertain, it reports `in_doubt`. It reports `failed` with `retryable` only
when it can prove the attempt had no effect. The server decides whether to
issue another attempt.

`delivery.settle` is the source of delivery outcomes. A receipt event records
only the observed delivery ID.

### Resolving an in-doubt attempt

An attempt settled as `in_doubt` stays open. The daemon sends another
`delivery.settle` for the same `attempt_id` when it establishes the effect.
It uses `applied` for a correlated delivery or `failed` for proven no effect.
Both resolutions require non-blank `resolution_evidence`. The server rejects
a resolution without evidence and returns `recorded` when it accepts one.

For `failed`, `retryable: true` lets the server consider a new attempt.
`retryable: false` ends automatic retry. A settle response of `duplicate`
means the server already recorded the identical outcome for that attempt,
including the same retryability for `failed`. A transition out of
`in_doubt` is a new outcome. Abandonment is a person or server action outside
the daemon protocol.

## Migration order

Link → events → inbox → commands → claims.
