# Relay wire contract v1

`@codecast/relay-contract` defines JSON text frames for the WebSocket relay.
The package uses standard JavaScript and has zero dependencies.

The relay carries transient display data and stores no durable data. The kernel
record decides who can act. Presence, cursor position, and heartbeat expiry
cannot grant, renew, release, or transfer a claim. Draft text stays in the
document step log. Messages, prompts, queues, leases, fencing tokens, and
commands stay on the kernel path. V1 has no frame variants for token deltas,
terminal traffic, or machine pushes.

## Connection and access

The kernel checks access and supplies the relay address and a short-lived signed
bearer token. The client sends the token once, in `connect`, over TLS.
The relay verifies the token signature, audience, and expiry before it accepts
the connection. The relay drops the token after verification. It never forwards
or logs the token. Later frames use the authenticated socket.

The signed token payload has these claims:

| Claim           | Value                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------- |
| `audience`      | ID of the relay or relay cell that can accept this token.                                               |
| `subject`       | `{ kind, id }` with kind `user` or `machine`.                                                           |
| `expires_at_ms` | Deadline for authorization on this socket, in Unix milliseconds.                                        |
| `grants`        | Named hubs `{ kind, id, publish }`. Each grant permits a subscription, even with an empty publish list. |

A hub is `{ kind: "session" | "machine", id }`. A session grant can list
`presence`, `cursor`, `baton_heartbeat`, and `session_liveness` in `publish`.
A machine grant can list `machine_liveness`. The kernel issues user subjects
for presence, cursors, and baton display heartbeats. It issues machine subjects
for liveness on their own machine hub and on session hubs for runs they own.
The relay checks the subject kind, hub grant, negotiated capability, and
publish rights for each signal. The relay gets the sender ID from the verified
subject. A subscription conveys no publish rights.

`parseRelayGrantClaims` checks the shape of the verified JSON payload. The
signing format and signature verification belong to the kernel and relay.
The relay closes the socket at authorization expiry. The client obtains a new
token, connects, and subscribes again. Each token limits the time that access
can continue after a kernel grant changes.

## Versions and parsing

`connect` and `hello` use a version-independent envelope. The relay selects the
highest common version and reports the capabilities both sides can use. V1
capability names match the five signal types. Unknown offered names grant no
capability. The client checks that `hello` selects an offered version and only
offered capabilities before it sends versioned frames.

A relay serves the newest released version and its predecessor when both
exist. Today only v1 exists. `negotiateRelayVersion` returns the highest common
positive safe integer or `null` if there is none. All frames after `hello`
carry `v` and must match the negotiated version. A new client field, a new
frame type, or a change to an existing field's meaning requires a new version.

`parseRelayClientFrame` rejects unknown fields, including fields in nested
objects. `parseRelayServerFrame` validates known fields and drops added fields
at every level. Both reject an unknown frame type or nested variant. On a failed
parse, the result contains a code and field path. Treat the path as untrusted
input. Forward only a parsed and authorized signal, with relay-stamped metadata.

## Frames

The table lists fields in addition to `type` and the post-handshake `v`.
A client can subscribe to any granted hub after `hello`. A publisher must
also subscribe to that hub before it sends a signal.

| Frame              | Sender            | Fields and meaning                                                                                                                                                | Expiry or failure                                                                                                                                |
| ------------------ | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `connect`          | Client            | `versions`, `capabilities`, `token`. First frame on the socket.                                                                                                   | The relay refuses a second connect or an invalid token.                                                                                          |
| `hello`            | Relay             | `status: "ok"` carries `version`, `capabilities`, `connection_id`, and `expires_at_ms`.                                                                           | The relay closes at expiry. `incompatible_version` carries `supported_versions`. `unauthorized` carries only its status. Both end the handshake. |
| `subscribe`        | Client            | `hub`. Adds this socket to one hub.                                                                                                                               | The relay checks the grant and returns `subscription`. A repeat is safe.                                                                         |
| `unsubscribe`      | Client            | `hub`. Removes this socket from one hub.                                                                                                                          | The relay returns `subscription`. A repeat is safe. Disconnect also removes the subscription.                                                    |
| `subscription`     | Relay             | `hub` and `status` with value `subscribed`, `unsubscribed`, or `denied`.                                                                                          | Success applies to this socket only. A denied request adds no subscription.                                                                      |
| `presence`         | User via relay    | `hub` (session). Shows a person present.                                                                                                                          | Remove the display at signal expiry.                                                                                                             |
| `cursor`           | User via relay    | `hub` (session), `cursor`. A draft cursor carries `revision`, `anchor`, and `head`. A reading cursor carries `message_id` and `offset`. `null` clears the cursor. | Remove at signal expiry. Use a cursor only with its matching draft revision or message.                                                          |
| `baton_heartbeat`  | User via relay    | `hub` (session). Shows a heartbeat for a user. Match the user to the holder in the kernel record before use.                                                      | Remove the heartbeat display at signal expiry. The claim's lease time comes from the record.                                                     |
| `session_liveness` | Machine via relay | `hub` (session), `run`. Shows contact from the machine for that run epoch.                                                                                        | Drop a signal for any other run. Use the kernel status when the signal expires.                                                                  |
| `machine_liveness` | Machine via relay | `hub` (machine). Shows contact from the machine named by the hub.                                                                                                 | Use the kernel status when the signal expires.                                                                                                   |

A draft cursor uses `kind: "draft"`. A reading cursor uses `kind: "reading"`.
Draft positions count UTF-16 code units in the shared draft at `revision`.
A reading offset gives the fraction of the message above the top of the viewport.

The relay adds `connection_id`, `seq`, and `expires_at_ms` to every signal.
It also adds `user_id` to user signals and `machine_id` to session liveness.
A new connection gets a fresh ID. A signal sequence increases within its source
connection, hub, and type. Discard duplicate and older sequences for that key.
A gap needs no replay. Each signal describes a current observation.

The relay sets each signal deadline from its TTL, capped at authorization
expiry. A receiver ignores a signal at or after that deadline. A new subscriber
waits for fresh signals. The relay does not keep a replay buffer. After a
disconnect, subscribe again and publish fresh signals. Clear the display for
an old source connection by expiry.

## Limits and failure

The transport must enforce an 8,192-byte UTF-8 limit before it accepts a full
frame. The parsers also enforce the limit before JSON decode. The limit applies
to the decoded token payload as well. JSON duplicate keys follow JSON parser
semantics. Each parser returns a fresh object with recognized fields only.

| Field                        | Limit                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| IDs                          | 1–128 ASCII letters, digits, underscores, colons, or hyphens.                                                                   |
| Token                        | 1–6,144 ASCII letters, digits, underscores, periods, or hyphens.                                                                |
| Versions                     | 1–8 entries. Each entry is a positive safe integer.                                                                             |
| Capabilities                 | 0–16 names. Each name starts with a lowercase ASCII letter and has up to 32 lowercase letters, digits, or underscores in total. |
| Hub grants                   | 1–32 grants. Each grant lists up to four session signals or one machine signal. The kernel supplies one grant per hub.          |
| Sequence, epoch, and expiry  | Positive safe integers. Expiry uses Unix milliseconds.                                                                          |
| Draft positions and revision | Non-negative safe integers.                                                                                                     |
| Reading offset               | A finite number from 0 to 1 inclusive.                                                                                          |

The relay rejects malformed or oversized client frames and drops unauthorized
signals. A client with a bad handshake response closes the socket. A client
drops a malformed or unknown signal. On relay failure, clients reconnect with
random backoff. The kernel remains the source for sends, queue state, baton
ownership, prompts, and durable status.
