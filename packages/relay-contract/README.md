# Relay wire contract v1

`@codecast/relay-contract` defines JSON text frames for the WebSocket relay.
It uses standard JavaScript and has zero dependencies.

The relay carries transient display data and stores no durable data. The
kernel record decides who can act. Presence, cursors, and heartbeats cannot
grant, renew, release, or transfer a claim. Draft text stays in the document
step log. Messages, prompts, queues, leases, fencing tokens, and commands
stay on the kernel path. Token deltas, terminal traffic, and machine pushes
are outside v1.

## Connection and authorization

The kernel checks access and supplies the relay address and a short-lived,
signed bearer token. The client sends the initial token in `connect` over TLS.
The client sends subsequent tokens in `grant_update` on the authenticated
socket. The relay verifies each token signature, audience, and expiry before
it grants access. It discards the token after verification. It never logs
or forwards a token.

The verified token payload has these claims:

| Claim           | Value                                                                                                                            |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `v`             | Version of the signed claims. V1 uses `1`.                                                                                       |
| `audience`      | ID of the relay or relay cell that can accept the token.                                                                         |
| `subject`       | `{ kind, id }` with kind `user` or `machine`.                                                                                    |
| `issued_at_ms`  | Issue time in Unix milliseconds. The kernel never decreases it for a subject.                                                    |
| `grant_seq`     | Positive sequence for this subject. The kernel increases it for each new token, including tokens issued in the same millisecond. |
| `expires_at_ms` | Authorization deadline in Unix milliseconds. Only the relay uses this clock.                                                     |
| `grants`        | Named hubs `{ kind, id, publish }`. Each grant permits a subscription. An empty publish list permits only a subscription.        |

A hub is `{ kind: "session" | "machine", id }`. A user can publish `presence`,
`draft_cursor`, `reading_cursor`, and `baton_heartbeat` to granted session hubs.
A machine can publish `session_liveness` to session hubs for runs it owns.
It can publish `machine_liveness` to its own machine hub. The kernel is
responsible for the scope of read access and the ownership of runs. The
parser refuses duplicate hub keys and duplicate publish rights.

`parseRelayGrantClaims` checks the verified payload shape and rights. The
kernel and relay implement signing and verification. The relay checks the
hub grant, its expiry, the negotiated capability, and the publish right
for each signal. It gets the sender ID from the verified subject.

### Token refresh

The relay processes grant updates in socket order and echoes `request_id`
in one `grant_result`. The client uses a distinct ID for each outstanding
update. Every token must name the same subject kind and ID as the initial
token. The relay accepts each token as a unit. The client sends new tokens
in issue order and obtains a fresh token if an update is stale.

`applyRelayGrantClaims` applies parsed claims after signature and audience
verification. It replaces the full grant and deadline for each named hub,
including any reduction in publish rights. It retains other live grants
and removes expired grants. A refusal leaves the current grants intact.
A non-finite clock reading refuses the update.

The relay keeps one high-water mark for the authenticated subject on the
socket. It records the latest accepted issue time and sequence, even after
it releases or prunes individual grants. A token with an earlier issue time
or an older sequence is stale. A new issue in the same millisecond uses a
higher sequence. The kernel never reuses the same issue time and sequence
for a different payload. An exact re-apply is a no-op for authorization.
It cannot reattach a released hub. The relay discards the high-water mark
when the socket closes. A new socket starts with a verified initial token
and its own high-water mark.

The client can send `grant_release` to free hub slots without a token.
The relay drops the named grants and subscriptions and then acknowledges
with `grant_result.released`. A release for an absent hub is a no-op.
`releaseRelayGrants` preserves the high-water mark. The relay retains only
verified grant data and applies expiry even when no update arrives.

A socket can hold up to 256 live hub grants across multiple tokens. This
supports 200 session hubs with room for machine hubs. Each token has its
own deadline. When a grant expires, the relay removes its subscription and
stops its traffic. It sends `subscription` with status `unsubscribed` and
reason `expired` before any close. The relay closes the socket when the
last grant expires or after it acknowledges release of the last grant.
The client can refresh before expiry or reconnect with a new token.

## Versions and parsers

`connect` and `hello` use a version-independent envelope. The relay selects the
highest shared version and returns the enabled capabilities that the client
offered. V1 signal capability names match the six signal types. An unknown
offered name grants no capability. The client checks the selected version
and capabilities before it sends a versioned frame.

Relays support wire versions N and N−1 when both exist. Today only v1 exists.
`negotiateRelayVersion` returns the highest shared positive safe integer,
or `null` if there is none. Each versioned frame carries the selected `v`.
A new client field, frame variant, or field meaning requires a new version.

Signed claims have their own N and N−1 rule. Today the relay only accepts
claims v1. The kernel must issue a claims version that the destination relay
supports. When v2 exists, the relay will use the specified schema for each
accepted version. The parser reads `v` before it reads fields from a
specific version. A valid but unsupported version gives
`unsupported_version`, even if the remaining fields are unfamiliar.
The relay refuses the entire token. On an open connection, this gives
`unsupported_grant_version`. Malformed claims, unknown fields in a
supported version, and unknown publish names give `invalid_token`.

All parsers accept JSON text and return a typed `invalid_input` error for
non-text input. Client frames and signed claims reject unknown fields.
The response parser validates known fields and drops added fields at every
level. Both frame parsers reject an unknown frame type or nested variant.
A failed parse returns a code and a field path. Treat the path as untrusted
input. Forward only a parsed and authorized signal.

## Frames

The table lists fields in addition to `type` and the post-handshake `v`.
A client can subscribe to any granted hub after `hello`. A publisher must
subscribe to the hub before it sends a signal.

| Frame              | Sender            | Fields                                                                                                                                     | Expiry or failure                                                                                                                                         |
| ------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connect`          | Client            | `versions`, `capabilities`, and `token`. First frame on the socket.                                                                        | The relay refuses a second connect or an invalid token.                                                                                                   |
| `hello`            | Relay             | `status: "ok"` carries `version`, `capabilities`, `connection_id`, and `ttl_ms`.                                                           | `incompatible_version` carries `supported_versions`. `unauthorized` gives no access. `unavailable` carries `retry_after_ms`. All three end the handshake. |
| `grant_update`     | Client            | `request_id` and `token`. Attaches or refreshes grants.                                                                                    | The relay returns `grant_result` with the same ID.                                                                                                        |
| `grant_release`    | Client            | `request_id` and `hubs`. Releases the named grants and subscriptions.                                                                      | The relay returns `grant_result` with the same ID.                                                                                                        |
| `grant_result`     | Relay             | `request_id` and `status`. `applied` carries the applied token’s `ttl_ms`. `released` acknowledges a release. `refused` carries `code`.    | Refusal codes are `invalid_token`, `unsupported_grant_version`, `expired`, `subject_mismatch`, `hub_limit`, `stale_token`, and `invalid_clock`.           |
| `subscribe`        | Client            | `hub`. Adds the socket to one hub.                                                                                                         | The relay checks the grant and returns `subscription`. A repeat is safe.                                                                                  |
| `unsubscribe`      | Client            | `hub`. Removes the socket from one hub.                                                                                                    | The relay returns `subscription`. A repeat is safe. Disconnect also removes the subscription.                                                             |
| `subscription`     | Relay             | `hub` and `status` of `subscribed`, `unsubscribed`, or `denied`. `unsubscribed` carries `reason` of `requested`, `released`, or `expired`. | Applies to this socket only. A denied request adds no subscription.                                                                                       |
| `presence`         | User via relay    | Session `hub`, `state` of `active` or `left`, and Boolean `in_draft`.                                                                      | Clear the observation on `left` or at TTL expiry.                                                                                                         |
| `draft_cursor`     | User via relay    | Session `hub` and `cursor` with `revision`, `anchor`, and `head`.                                                                          | Clear only the draft cursor on `null` or expiry. Use positions only with the matching draft revision.                                                     |
| `reading_cursor`   | User via relay    | Session `hub` and `cursor` with `message_id` and `offset`.                                                                                 | Clear only the reading cursor on `null` or expiry. Use the offset only with the matching message.                                                         |
| `baton_heartbeat`  | User via relay    | Session `hub`. Match the user to the holder in the kernel record before display.                                                           | Clear the observation at expiry. The claim's lease time comes from the record.                                                                            |
| `session_liveness` | Machine via relay | Session `hub` and `run`. Reports contact from the machine for that run epoch.                                                              | Drop a signal for any other run. Use the kernel status when the observation expires.                                                                      |
| `machine_liveness` | Machine via relay | Machine `hub`. Reports contact from the machine that the hub names.                                                                        | Use the kernel status when the observation expires.                                                                                                       |

Draft positions count UTF-16 code units in the shared draft at `revision`.
A reading offset gives the fraction of the message above the viewport.

### Signal order and expiry

The relay stamps each signal with `connection_id`, `seq`, and `ttl_ms`.
It stamps `user_id` on user signals and `machine_id` on session liveness.
A new connection gets a fresh ID. A signal sequence increases for its
source connection, hub, and type. Draft and reading cursors have separate
sequences. Discard a duplicate or older sequence for the same key. The
relay sends updates for a source connection and hub in order, including
departures. A gap needs no replay. The relay keeps no replay buffer.

The relay accounts for time in its queue before it sends a timed signal.
At send, it caps the signal's remaining TTL at the time left on the
source authorization and the recipient's authorization for that hub.
The receiver starts the TTL at receipt on a monotonic clock. The
`hello.ok` TTL measures the remaining life of the initial token.
The `grant_result.applied` TTL measures the remaining life of the token
in that update, even if some other grant expires later. The relay
calculates both from its send time. These TTLs grant no rights. The relay
enforces the actual deadlines independently of client clocks.

Receivers key presence and cursor observations by hub and source
`connection_id`. A person is active in a hub when any of that person's
connections is active there. A `presence` signal with `state: "left"` carries `in_draft: false`.
The relay emits it for an active publisher after unsubscribe, disconnect,
or loss of permission to publish presence. The relay stamps it with the
departing connection ID, the next presence sequence, and `ttl_ms: 0`.
Apply an ordered departure immediately. It clears presence and both
cursors for that hub and connection only. Other connections still count
toward the person's presence. A cursor signal with `cursor: null` carries
`ttl_ms: 0` and clears only its cursor type for that hub and connection.
A clear has no display lifetime. If the relay loses a clear, the previous
observation still expires by its TTL. A client can publish a departure
directly while it retains access.

## Limits and failure

The transport must enforce an 8,192-byte UTF-8 limit before it accepts a
full frame. The parsers also enforce this limit before JSON decode. The
limit also applies to the decoded token payload. JSON duplicate keys follow
JSON parser semantics. Each parser returns a fresh object.

| Field                                | Limit                                                                                                                                                 |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| IDs                                  | 1–128 ASCII letters, digits, underscores, colons, or hyphens.                                                                                         |
| Token                                | 1–6,144 ASCII letters, digits, underscores, periods, or hyphens.                                                                                      |
| Versions                             | 1–8 entries. Each entry is a positive safe integer.                                                                                                   |
| Capabilities                         | 0–16 names. Each name starts with a lowercase ASCII letter and has up to 32 lowercase letters, digits, or underscores in total.                       |
| Token grants                         | 1–16 distinct hubs. The 16-hub limit leaves room for a compact signature envelope within the token byte cap, even with maximal IDs and publish lists. |
| Socket grants                        | 256 distinct unexpired hubs across all tokens.                                                                                                        |
| Release list                         | 1–16 hub names per frame.                                                                                                                             |
| Sequence, epoch, timestamps, and TTL | Positive safe integers. Issue time must precede expiry. TTL uses milliseconds. A presence departure or cursor clear uses zero.                        |
| Draft positions and revision         | Non-negative safe integers.                                                                                                                           |
| Reading offset                       | A finite number from 0 to 1 inclusive.                                                                                                                |
| Retry delay                          | Non-negative safe integer in milliseconds.                                                                                                            |

The relay rejects malformed or oversized client frames and drops unauthorized
signals. A client closes the socket after a bad handshake and drops a malformed
or unknown signal. On failure, a client reconnects with random backoff.
After `unavailable`, it waits at least `retry_after_ms`. After reconnect, the
client subscribes again and publishes fresh signals. The kernel remains the
source for sends, queues, baton ownership, prompts, and durable status.
