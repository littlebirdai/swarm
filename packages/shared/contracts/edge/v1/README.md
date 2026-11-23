# codecast edge/v1

This is the JSON contract between the codecast daemon and server. Import it from
`@codecast/shared/contracts/edge/v1`. Each verb has request and response parsers.
They return the parsed value or an `EdgeParseError` with a field path and error
code. Parsers reject unknown fields in fixed wire objects.

## Versions

`hello` is the bootstrap exchange. The daemon sends the versions it speaks.
The server selects the highest shared version or returns `upgrade_required`.
The server supports its newest released version and the previous version when
one exists. The first release supports v1. Subsequent v1 messages carry `v: 1`.

The v1 wire format freezes on release. Any wire field change, including an
addition, goes in v2. Keep the v1 parsers and fixtures when a new version ships.

## Events and claims

An event has a session ID, a run epoch, and a sequence number for that session.
Sequence numbers are positive safe integers and continue across run epochs.
`at` and `expires_at` use Unix time in milliseconds. A null `turn` means the
event has no associated turn. Event batches use one session and run claim,
with events in increasing sequence order. `message.delta` is a relay frame with
its own parser and does not consume a durable event sequence number.

The server grants a fencing token for a session and run epoch. The daemon sends
it with event appends, inbox writes, claim renewals and releases, and results
for commands that carry a claim. Blob uploads and machine commands use the
machine and boot identity. The server verifies the token and expiry against its
current claim before it accepts a claimed write. For command results, the
server checks whether the original command requires a claim.
The daemon reuses its `claim_id` when it retries the same claim request.

## Delivery policy

The server supplies the effective intent on each permit. The sender identifies
a person or an agent session. The server issues `queue` for agent senders by
default and can issue `steer` after the session owner grants that sender steer.
The permit's `seq` orders deliveries within the session. The daemon echoes the
permit fields and reports the delivery outcome.

## Migration order

Link → events → inbox → commands → claims.
