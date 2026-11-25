# codecast edge/v1

This is the JSON contract between the codecast daemon and server. Import it from
`@codecast/edge-contract`. Each verb has request and response parsers.
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

### Prompt details

The body of `prompt.opened` can carry four optional fields. Text limits use
UTF-16 code units.

- `tool_call_id` has a limit of 256.
- `tool_name` has a limit of 128.
- `summary` is a redacted single line with a limit of 500.
- `rule_request` has `permission`, `patterns`, `always`, and an optional
  boolean `opaque`. It uses the same fields as the permission rule request.
  The permission name has a limit of 80. The arrays have limits of 32
  `patterns` and 8 `always` entries, each up to 1,000 code units.
  An opaque request with one pattern and no `always` entries can carry up to
  32,000 code units in its pattern.

The machine must redact the summary before it sends the event. The server
decides whether the prompt is routine. It can verify a read inside the
workspace or a question that runs no code. Pass that verification to
`classifyPrompt`. A verified question needs a summary. A verified workspace
read also needs a tool call ID, a tool name, and a `read` rule request with
at least one pattern. Each pattern must be non-blank. The default is
escalation. An opaque rule request always gives an escalation.

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
the delivery fields, including `attempt_id`. The `expected` field stays on
the permit. A permit marked `started` or a
start response of `already_started` requires recovery before another effect.
The daemon checks the transcript for the original effect. If the result is
uncertain, it reports `in_doubt`. It reports `failed` with `retryable` only
when it can prove the attempt had no effect. The server decides whether to
issue another attempt.

`delivery.settle` is the source of delivery outcomes. A receipt event records
only the observed delivery ID.

### Guarded actions

A daemon that checks `expected` advertises `EXPECTED_CAPABILITY` (`"expected"`)
in its `hello` request. The server sends guarded steers and commands only to
daemons that advertise this capability. A guarded steer queues if the daemon
does not advertise it.

`permits.next` can include a turn guard. `commands.next` can include any
of these guards.

| Action             | `expected`                                                          |
| ------------------ | ------------------------------------------------------------------- |
| Steer or interrupt | `{ "kind": "turn", "turn": "turn-1" }`                              |
| Prompt answer      | `{ "kind": "prompt", "prompt_id": "prompt-1", "run": 3 }`           |
| Terminal input     | `{ "kind": "terminal", "pane_instance": 4, "fencing_token": "17" }` |

A null `turn` names the state with no current turn. The pane instance is a
positive safe integer that identifies one pane lifetime within a session.
Use a new instance when the pane restarts. The terminal `fencing_token`
is the typing lease token encoded as text. The daemon compares it for
equality. The server alone orders the tokens.

The server checks the guard when it starts the action. The daemon checks
it again immediately before the effect. Both can use `matchesExpected`.
An absent guard keeps the existing behavior. A mismatch prevents the
effect.

The daemon reports a mismatch with `outcome: "stale"` and a required
`observed` field in `delivery.settle` or `commands.result`. Use the same
kind as the guard and report the current values. Use null for an absent
turn, prompt ID, pane instance, or typing lease token. A prompt observation
uses null for `run` when there is no active run. Only a stale outcome carries
`observed`. A stale command result has no `output`.

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
