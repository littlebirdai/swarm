# codecast edge/v1

This is the wire contract between the codecast daemon and server. Import the
JSON request and response parsers from `@codecast/edge-contract`. They return
the parsed value or an `EdgeParseError` with a field path and code.

## Versions and compatibility

`hello` selects the highest shared version. If every offered version is newer
than the server supports, it returns `server_behind`. Other failures to agree
return `upgrade_required`. The server supports the newest released version and
the previous one when both exist. Versioned messages carry `v: 1`.

The v1 requests and the meaning of its responses freeze on release. The server
rejects unknown request fields, including nested fields in fixed wire objects.
The daemon validates known response fields and ignores added fields, including
policy settings. This lets the server add optional response fields and policy
settings in v1. A new request field, a change to an existing field, or a new
response variant requires v2.

### Release compatibility checks

After the first release, the CI contract job reads the latest daemon requests
frozen in the base commit with the
current package and reads current responses with the parser from the
frozen source commit. It checks additive response and policy fields and
unfamiliar error codes. The backend inventory check reports missing public
functions and HTTP routes named in the frozen daemon, web and mobile source
references. It detects literal references and generated API member access.
The source scan can miss dynamically constructed references. The tests
run locally with source and fixtures.

From the clean source commit used to cut a release, run
`bun --no-env-file scripts/ci/freeze-edge-contract.ts <release-version>`.
Commit the generated version directory under `test/releases/`. It contains the
wire fixtures, source commit, client inventory, and fixture digests. Keep the
source commit in the repository's history. CI compares existing directories
with the PR base or previous main commit and rejects edits, additions, and
deletions in frozen directories. Make future fixture changes under
`test/fixtures/` and add a version directory at the next release.

Freeze the first released version when its client and server ship. Until
then, CI runs the current wire tests and the freeze guard tests.

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
epochs. Timestamps use Unix time in milliseconds. A null
`turn` means the event has no associated turn.

One append can carry several event groups. Each group has one session, epoch,
and fencing token. The events in a group are contiguous. The server returns one
result per group, in request order. A gap reports the next expected sequence
number. A conflict reports the sequence number of a stored event with different
content. A stale claim affects only its own group.

The event envelope has 17 durable kinds. The live transcript relay channel
carries `message.delta`. The delta offset counts UTF-16 code units from the
start of the message. Deltas use the same `message_id` as the final assistant
event and do not consume a durable sequence number.

The server assigns the run epoch and grants a fencing token. The daemon sends
the token with event groups, inbox writes, claim renewals and releases, and
results for commands that carry a claim. The server checks the current claim
and its expiry before it accepts a claimed write. The daemon reuses its
`claim_id` when it retries the same acquisition request.

A granted `claim` and a renewed `renew` carry `lease_ms`, the time that remains
on the lease when the server makes the response. The value is a duration
because the clocks of the server and the machine can differ. The server
calculates it again for each response, and a repeated `claim_id` does not get
the initial value. The daemon counts `lease_ms` from the moment before it sent
the request, on a monotonic clock. Thus, the daemon stops before the lease ends
on the server. A lease with no time left is not a grant: the server returns
`stale`.

A granted `claim` can include `last_event_seq`. This is the run
cursor. It can hold the start sequence of a new run or the last sequence
that the server accepted for that run. The daemon continues after this value.

### Run lease checks for execution writes

Each operation also checks the caller's authority and the required epoch.
Delivery rejection requires the current epoch.

| Caller and binding state                                                      | Token                              | Result                                |
| ----------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------- |
| Run holder, ready binding with a claim                                        | Matching token for an active lease | The write can proceed.                |
| Recovery or legacy caller, non-ready binding or ready binding without a claim | Absent                             | The write can proceed.                |
| Any caller, ready binding with a claim                                        | Absent                             | The server returns `STALE_RUN_LEASE`. |
| Any caller, binding without a matching active lease                           | Present                            | The server returns `STALE_RUN_LEASE`. |

The holder uses its active token to record runtime disposition. An exact
replay returns the stored result without writing. After disposition, recovery
requests omit the old token.

When a device's registered replacement boot adopts its current ready binding,
the server updates the binding and its active delivery in one transaction.

| Active delivery state | Result of boot transfer                                                                                                                  |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `claimed`             | The server releases the attempt before effect and queues the same delivery ID at the same sequence. A new claim issues a new attempt ID. |
| `delivery-started`    | The attempt becomes ambiguous and keeps its queue slot. The server transfers resolution authority to the replacement boot.               |
| `ambiguous`           | The attempt keeps its queue slot and failure details. The server transfers resolution authority to the replacement boot.                 |

The server rejects late writes that use the old boot's delivery fence. There is
one exception: a release or a failure before effect of an attempt that the
transfer already released answers as a replay and writes nothing.
Resolution requires evidence. A leased binding requires a new active token
for delivery writes after adoption. A binding without a claim accepts delivery
writes without a token. The next boot transfer also repairs a slot that still
names a boot from an earlier transfer.

### Terminal lifecycle

`terminal.started` records the pane instance and its starter. The `actor` has
an `id` and a `kind` of `person` or `agent`. Include `tool_call_id` if a tool call
started the pane. Actor and tool call IDs are non-blank and have a limit of
256 UTF-16 code units each. Use only IDs in these fields.
Screen content, keystrokes, commands, and environment data stay outside these events.

`terminal.ended` records only `pane_instance`, `started_run` and `outcome` in its body.
`started_run` is the run of the start event.

| Outcome                                     | Meaning                                                                                                              |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `{ "kind": "exit", "code": 0 }`             | The process exited. `code` is a non-negative safe integer.                                                           |
| `{ "kind": "signal", "signal": "SIGTERM" }` | A signal ended the process. `signal` is the name that the machine's system gives, such as `SIGTERM` or `SIGRTMIN+1`. |
| `{ "kind": "replaced" }`                    | A new pane replaced this pane.                                                                                       |
| `{ "kind": "lost" }`                        | The daemon lost the pane and has no exit status.                                                                     |

Each granted `claim` supplies `last_pane_instance`, the server's highest
accepted pane number for the session, or zero if none. After each grant, the
daemon seeds its next number with `max(local_reserved, last_pane_instance) + 1`.
The daemon records each reservation in durable local storage for that session
before it uses the number. If the local journal is absent, use zero for
`local_reserved`. Stop if the last number is `Number.MAX_SAFE_INTEGER`.

The server grants a typing lease only after it accepts the pane's start for
the current run. If a different daemon never reported a local reservation,
its pane could not have received a lease. A later run can reuse that
unreported number. The run in each terminal guard distinguishes the two.

If a pane survives a run change, the daemon reports `replaced` for the old
instance and starts a new instance for the same pane under the new claim.
The replacement ends the old typing lease. The envelope's `run` identifies
the claim that reports the event. The server uses the session, `started_run` and the
pane number to match an end to its start across claims.

The server records an end even if the start is missing. The first end
determines the outcome. A late start supplies metadata for the ended
instance. A repeated start with the same run, turn, and body is
idempotent. The server refuses a repeated start with different fields.

Both kinds are part of v1 because v1 is still unreleased. After release, a
new event kind requires a negotiated capability. The daemon sends it only
when the server advertises support.

### Prompt details

The body of `prompt.opened` can carry these optional fields. Text limits use
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
- `options` holds 1 to 16 entries. Omit it when the prompt has no options.
  Each entry has a non-blank `id` and a non-blank, single-line `label`.
  Both have a limit of 128 code units. IDs must be unique within the prompt.
  The optional `kind` is `allow_once`, `allow_always`, `reject_once`, or
  `reject_always`.

The machine must apply the same redaction to agent-supplied option labels
and to the summary before it sends the event.

An option selection is an object such as `{ "option_id": "allow-once" }`.
Use this object in the `prompt_answer` command's `args.answer` and in
`prompt.settled.body.answer`. A string answer is free text. The handler
applies an option only when the open prompt offered that ID.

The server decides whether the prompt is routine independently of its
options. It can verify a read inside the workspace or a question that runs
no code. Pass that verification to
`classifyPrompt`. A verified question needs a prompt of kind `question` and a
non-blank summary. A verified workspace read needs a prompt of kind
`permission`, a non-blank summary, a tool call ID, a tool name, and a `read` rule request with
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
supplies the content type. A start response can repeat the permit's input
parts in its optional `input` field.

### Read a delivery blob

Send `POST /edge/v1/blobs.get` with the device-bound bearer token in the
`Authorization` header. Send `v`, `session`, `run`, `fencing_token`,
`attempt_id`, and `blob_id` in the JSON body. Use the claim and attempt from
the permit and the ID from its blob part. The server checks the active lease
and verifies that the blob belongs to that permit.

HTTP 200 returns the raw bytes with the part's `Content-Type`. The server
serves the bytes directly. The permit has no download URL, and the route
never redirects. Repeating a read does not change the lease, permit, or blob.
The server checks authority on each read.

The server enforces policy `limits.max_blob_bytes` (8 MiB, or 8,388,608 bytes,
in the advertised policy) and returns HTTP 413 with `too_large` above that
limit. The daemon counts the bytes it receives and rejects a response above
the policy limit, even if the response supplies a smaller `Content-Length`.

HTTP 404 with the typed `not_found` error means the blob is unavailable for
this permit. An old server returns its unknown-route response. Treat that
response as “blobs not supported.” The daemon must establish blob-read support
before it claims a run that needs blobs.

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

| Action             | `expected`                                                                    |
| ------------------ | ----------------------------------------------------------------------------- |
| Steer or interrupt | `{ "kind": "turn", "turn": "turn-1" }`                                        |
| Prompt answer      | `{ "kind": "prompt", "prompt_id": "prompt-1", "run": 3 }`                     |
| Terminal input     | `{ "kind": "terminal", "run": 3, "pane_instance": 4, "fencing_token": "17" }` |

A null `turn` names the state with no current turn. The pane instance is a
positive safe integer. Use a new instance when the pane restarts. The
terminal `fencing_token` is the typing lease token encoded as text. The daemon
compares the run, pane instance, and token for equality. The server alone
orders the tokens.

The server checks the guard when it starts the action. The daemon checks
it again immediately before the effect. Both can use `matchesExpected`.
An absent guard keeps the existing behavior. A mismatch prevents the
effect.

The daemon reports a mismatch with `outcome: "stale"` and a required
`observed` field in `delivery.settle` or `commands.result`. Use the same
kind as the guard and report the current values. Use null for an absent
turn, prompt ID, pane instance, or typing lease token. Prompt and terminal
observations use null for `run` when there is no active run. Only a stale
outcome carries `observed`. A stale command result has no `output`.

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
