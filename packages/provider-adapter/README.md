# Provider adapter

Use `@codecast/provider-adapter` for the Promise API or
`@codecast/provider-adapter/effect` in an Effect service. The registry
supports Grok 1.0.13 over ACP, Codex 0.153.4 over app-server, and
Claude Code 2.1.319 over stream-json on POSIX.

The machine service emits `session.started` and passes the last durable
sequence as `afterSeq`. The adapter starts its events after that sequence.

Read events with one consumer. Close the owned session to stop the
provider's process group. The adapter signals the group once, at scope
close or when the leader exits, whichever happens first.

A clean ACP write returns `in-doubt` because ACP provides no durable
delivery receipt. A prompt reply can still end its turn after a timeout.
The raw sink receives original provider frames, which can contain secrets.
The adapter redacts the stderr callback and provider error messages.

ACP permission prompts show up to 16 choices in provider order. The adapter
keeps IDs verbatim, skips blank or oversized IDs, and shows the first
occurrence of a duplicate ID. It redacts labels and the summary, joins
lines with spaces, and trims labels to 128 code units and the summary to 500. A missing or blank label becomes `Option N`. Only recognized ACP
kinds appear on choices. If no ID fits, the prompt omits the options list.
Send `{ "option_id": "…" }` to select a displayed choice. Semantic allow
and deny can also select valid provider IDs beyond the display limits.

## Codex app-server

The adapter checks the version with `initialize`, sends `initialized`,
then starts or resumes one thread per process. Set model, sandbox, approval,
and provider config in `StartSpec.options`. New turns restate the sandbox
supplied by the server. Resume uses the server's policy.

RPCs acknowledge steer and interrupt against the expected turn. Only
`turn/completed` or exit ends the turn. A steer remains `in-doubt`.
The [recorded user item](../../apps/cli/src/__fixtures__/codexCloud/turns.ask.json)
has a null `clientId`. Resume can identify a live turn and supplies no
durable delivery receipts. Controls settle while the consumer waits.
The reader stages 64 frames or 32 MiB. Overflow fails the stream and
reports pending controls as `in-doubt`.

Semantic allow or deny answers command, file change, and permission
prompts. Grants apply to the current turn. Questions and choices appear
in linked context. Send `{ "answers": { "<id>": { "answers": ["…"] } } }`.
The canonical settlement masks secret answers. A server cancellation or
turn end retires the prompt locally. Only a user's answer emits a settlement.

Compared with the [legacy client](../../apps/cli/src/codexAppServer.ts):

- Kept initialization, start and resume, sandbox restatement, local images,
  turn and item notifications, tool output, thread status and name, and
  command, file, and permission approvals.
- The adapter owns one process group per thread and fences controls by
  turn ID. It emits offset-based deltas, canonical messages, tool events,
  and context for output deltas, reasoning, plans, and images. It redacts
  diagnostics. The machine service emits `session.started`.
- The legacy client retains account refresh, restart, quarantine, turn
  recovery, forks, worktrees, hook suppression, policy persistence and
  invalidation, per-turn overrides, transcript grouping, image extraction,
  error banners, dynamic tool requests, and legacy approval RPCs.
- The raw record retains tokens, account notices, diffs, item metadata,
  the `thread/started` notice, commentary phase, and per-message model.

## Claude SDK stream-json

The adapter starts one Claude Code 2.1.319 process on POSIX and checks its
version at initialize. Start generates a session UUID. Resume passes the
saved UUID to `--resume`. Claude loads the conversation on first input.
Set `model`, `permissionMode`, `systemPrompt`, or `appendSystemPrompt` in
`StartSpec.options`. Permission modes are `default`, `acceptEdits`, `plan`,
and `dontAsk`. `ProviderAdapterOptions.command` supplies the executable
prefix. The adapter appends the protocol flags and enables persistence.

The [current CLI session](../../apps/cli/src/claudeSdk/session.ts) and the
adapter use the same checkpoint, text and image input, mid-turn `next`
priority, tool prompts, and `/clear` reset. Claude reports the new checkpoint
without a process restart. The adapter uses local turn IDs and canonical
events. Result and lifecycle UUIDs attribute input to a delivery.
Writes remain `in-doubt`. Resume recovers no durable delivery receipts.
Recent repeated IDs in the same process are suppressed.

Interrupt returns on its acknowledgement. Queued input can survive it.
Result, idle, or exit ends a turn. Idle without a result emits `no-result`.
Initialize and interrupt replies time out after 30 seconds. Controls
settle while the shared bounded stdout reader waits for event space.

Permission answers use exactly one offered `option_id` or a semantic
`behavior` of `allow` or `deny`. For a single-choice question, use its
displayed `option_id`. Linked context lists IDs and choices for other
questions. Answer with `{ "answers": { "<id>": { "answers": ["…"] } } }`
and include one entry per question. A null answer dismisses a question.
A successful prompt write emits a local settlement and returns `in-doubt`.

The current CLI path retains the reconnectable host, account selection,
launchd, daemon hooks, transcript files, automatic restart, permission
rule persistence, plan-mode restoration, and live model or mode changes.
The adapter keeps other protocol frames in the raw record.
