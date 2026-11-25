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

The adapter starts one process per owned thread. It checks the version
reported by `initialize`, sends `initialized`, and opens or resumes the
thread. Supply thread settings in `StartSpec.options`, including the model,
sandbox mode, approval policy, and provider config. New turns restate the
sandbox policy returned by the server when it supplies one. The adapter
does not infer a broader policy for a resumed thread.

The app-server acknowledges a mid-turn steer for an expected turn ID and
acknowledges an interrupt by RPC. Acknowledging an interrupt does not end
the canonical turn. `turn/completed` or process exit ends it. A successful
steer is still `in-doubt`. `turn/start` returns a turn, and `turn/steer`
returns a turn ID. Neither result identifies an inbox delivery. The
[recorded user item](../../apps/cli/src/__fixtures__/codexCloud/turns.ask.json)
has a null `clientId`. A resumed thread restores its checkpoint and can
identify a live turn, but this adapter advertises no receipts or recovery
by delivery ID.

Control RPCs can settle while the event consumer is paused. The stdio
reader stages up to 64 frames and 32 MiB ahead of event projection.
Events from replies still follow earlier notifications. Exceeding the
read-ahead limit fails the stream and reports outstanding controls as
`in-doubt`.

Use semantic allow or deny for command, file change, and permission
approvals. Permission grants apply to the current turn. For a question,
return `{ "answers": { "<question-id>": { "answers": ["…"] } } }`. A context
event linked to the prompt carries the questions and their choices.
The provider receives secret answers, and the canonical settlement masks
them. A provider-resolved request is retired locally. The contract's
`prompt.settled` event requires a real answer and actor, so a server
resolution or turn teardown cannot publish an actorless settlement.

Compared with the [legacy client](../../apps/cli/src/codexAppServer.ts):

- Kept stdio initialization, thread start and resume, server-reported
  sandbox restatement, local image input, turn and item notifications,
  tool output, thread name and status updates, and command, file, and
  permission approvals.
- Changed process ownership from a shared restarting client to one
  scoped process group per thread. Provider turn IDs fence all controls.
  Assistant deltas carry offsets. Completed items emit canonical
  messages and tool events. Output deltas, reasoning, plan, and image
  metadata use context events. Diagnostic text is redacted. Questions
  accept explicit answers and permission grants use turn scope. The machine
  service owns `session.started`, and the adapter retains the provider's
  `thread/started` notice as raw data.
- The scoped adapter leaves account refresh, restart and quarantine
  policy, automatic turn recovery, thread forks, worktree configuration,
  hook suppression, and policy persistence to the caller. Per-turn model
  or sandbox overrides and explicit policy invalidation are outside
  the adapter's control interface. The legacy transcript grouping, inline
  image extraction, error banners, dynamic tool requests, and legacy
  approval RPCs also stay in the old path.
- Raw tokens, account notices, diffs, and item metadata remain available
  for replay. The canonical contract has no dedicated reasoning, plan,
  image-result, or multi-question events. The assistant-message body
  carries text and an ID, so commentary phase and per-message model
  metadata stay in the raw record where the provider supplies them.

## Claude SDK stream-json

The adapter runs Claude Code 2.1.319 on POSIX and checks the version from
`initialize`. It starts one scoped process per owned session. A fresh
session uses a generated UUID. Resume passes the saved Claude session UUID
to `--resume`. Initialization confirms the process and protocol version.
Claude loads the saved conversation when it handles the first input.

Set `model`, `permissionMode`, `systemPrompt`, or `appendSystemPrompt` in
`StartSpec.options`. The supported permission modes are `default`,
`acceptEdits`, `plan`, and `dontAsk`. The adapter appends its stream-json
and session flags to the executable prefix in `ProviderAdapterOptions.command`.
The default executable is `claude`. The child uses the SDK entrypoint
and saves a session for later resume.

An idle message starts a turn when Claude reports activity. A mid-turn
message uses priority `next`. Command lifecycle frames and results identify
inputs by their generated UUIDs. The adapter uses that match to attach
inbox authors and delivery IDs to user events. A clean write returns
`in-doubt`. The stream provides neither durable inbox receipts nor receipt
recovery after resume. The adapter suppresses recent repeated delivery
IDs within the same process.

An interrupt response confirms the control. A result, idle state, or
process exit ends the turn. Queued input can survive an interrupt. A turn
that returns to idle without a result ends with reason `no-result`.
The adapter uses the new session UUID from Claude after `/clear`.
It retains the original process. The stdout reader shares the app-server
frame and byte limits, so controls can settle while event delivery waits.
An initialize or interrupt reply times out after 30 seconds.

Permission prompts offer Allow and Deny. Send the displayed `option_id`
or a semantic `{ "behavior": "allow" }` or `{ "behavior": "deny" }`.
For a single-choice question, send a displayed `option_id`. Other questions
use a linked context event with question IDs and choices. Send
`{ "answers": { "<question-id>": { "answers": ["…"] } } }` with one entry
per question. A null answer denies a request. A successful prompt reply
write emits the local settlement and returns `in-doubt`. Claude does not
send a separate acknowledgement for that reply.

Compared with the [current CLI session](../../apps/cli/src/claudeSdk/session.ts):

- Kept stream-json initialization, checkpoint resume, text and local
  image input, mid-turn priority, interrupt, per-tool prompts, question
  choices, session reset, and result and lifecycle error handling.
- Changed ownership to one process group per adapter session. Canonical
  events carry local turn IDs and durable sequence numbers. Interrupt
  returns on the protocol acknowledgement. Consumers read the turn end
  from the event stream. Assistant output uses complete message frames.
- The adapter leaves the reconnectable host, account selection, launchd,
  daemon status hooks, transcript files, automatic restart, permission
  rule persistence, plan-mode restoration, and live model or permission
  changes to the current CLI path. It keeps other protocol frames in
  the raw record.
