# Edge events

## Request and answer

`POST /edge/v1/events.append` uses a device bearer token. The body has
`v: 1` and `batches`. Each batch has `session`, `run`, `fencing_token`,
and a nonempty array of canonical events. Each event names the batch
session and run. The event sequence is positive and contiguous within a
batch. Relay deltas use a separate channel and do not consume a sequence.

The answer has `v: 1` and one result per batch in request order.
Each result names the session.

| Result     | Meaning                                                                      |
| ---------- | ---------------------------------------------------------------------------- |
| `appended` | The batch succeeded. `through_seq` is the cursor, also for a complete retry. |
| `gap`      | A sequence is missing. `expected_seq` is the first missing sequence.         |
| `stale`    | A run or lease fence failed.                                                 |
| `conflict` | The contract defines this result. The server does not emit it.               |

## Acceptance

The route accepts a body of up to 512 KiB and 100 events. Its device
budget is 240 batches per minute. A refusal leaves the budget count unchanged. The parser applies the text limits in
the contract in UTF-16 code units. The route also limits turn and prompt
IDs to 256 UTF-16 code units. The route runs one mutation for each batch, in request
order.

The mutation verifies the device, owner, current `execution_bindings` row, run,
and active lease. It checks the lease token and the boot on the lease
against that row. The request carries neither the machine nor the
boot. The mutation checks the fence before it reads the cursor.

If the conversation moves to a different device, the old device loses
access to new work. It can still settle an attempt that it started if
the account, run, lease, and attempt fences still match.

The cursor row holds the last accepted sequence. The server sets the base
when the epoch becomes active. The first epoch starts at zero. A successor
starts at the last cursor from an earlier epoch. When the flag is off,
epoch activation skips both rows. The first claim after enablement seeds them.

A granted claim can return the cursor
as `last_event_seq`. A daemon that restarts continues after that value
with or without a spool.

The server treats events at or below the cursor as duplicates. It uses
the sequence alone to identify a duplicate. If a suffix starts after
the next sequence, the server returns `gap` and writes zero rows.
A complete retry writes zero rows and returns `appended`. Otherwise the
server applies the suffix and advances the cursor in one transaction.

## Durable turn projection

The cursor row and turn row belong to one `execution_bindings` row. Each table
has indexes for the conversation and owner. The turn row holds the run,
status, recent turn IDs, and the open turn. The open turn holds its ID
and a set of up to 32 open prompt IDs. A settlement removes one ID.
The turn stays blocked until the last prompt settles.

The turn row stores no authors. Use the server delivery record to identify
the sender who started the turn. If there is no such record, the sender
is unknown. A new boot or a replacement lease for a dead process clears
the open turn, its prompts, and the recent turn IDs. Adapters can reuse
turn IDs after a restart.

A fresh projection requires a ready `execution_bindings` row and an active lease.
It also requires the same run, the current version, and active status.

Permit and command mutations read the turn row when they issue or start an action.
Guarded actions require a fresh projection and the provider's own guard.
The turn ID sets `expected` for a steer. An answer names its prompt ID.
The baton can hold for the open turn.

For an older version, a batch advances the cursor and leaves the turn row
as it is. A new run or boot resets the turn row to the current version.

A batch writes only the cursor row and, if its value changes, the turn
row. A cursor write does not cause a new read of the turn row.
No client subscription reads either row. The route does not write
messages, the queue, the baton, session status, or the heartbeat.
Transcripts keep their current path.

## Replay measurements and cost

These samples give UTF-8 bytes for the JSON event array. The sizes exclude
relay deltas, HTTP headers, and the request envelope.

| Recording                 | Events per turn | Bytes per turn |
| ------------------------- | --------------: | -------------: |
| Grok ACP file list        |               9 |          1,931 |
| Codex app-server command  |               6 |          2,101 |
| Claude SDK tool allowance |               9 |          2,262 |

At one turn per second, the largest samples give 9 events and 2.3 kB per
second. A 250 ms flush interval gives up to four requests per second per
machine. Each run batch that adds events writes one cursor row and at most
one turn row. One flush per turn needs at most two row writes per second
in this example. Four flushes need at most eight for the same run.

Storage stays at two rows per run. The cursor holds one sequence value.
The turn row retains up to 32 recent turn IDs and 32 open prompt IDs.
The server keeps no event bodies or digests in these rows.

## Status and deletion

Keep `agent_status` for display. It can report `working` before a turn
opens or `idle` after a transcript update. Compare the two states for
the same run by server receipt time. Count differences by provider and
direction. If the projection is not fresh, queue a steer or refuse the
guarded action.

Revoke the run lease before deletion of child rows. Delete both rows
with the conversation in the session, team, and account purge plans.
Keep a predecessor cursor until the successor takes its base or the
purge removes the conversation.
