# Provider adapter cutover

Main supports owned Grok 1.0.13 over ACP and Codex 0.153.4 over app-server.
Claude Code stream-json is in PR #181.
[Provider adapter](../../packages/provider-adapter/README.md)

## Contract for all dialects

An observed session reads a transcript and can offer fenced terminal paste. An
owned session starts or resumes by checkpoint. Both expose one event reader.
Continue durable events after the saved sequence. Match the run and fence
before a write. Steer also checks the turn or confirmed idle state.
Interrupt names an active turn. An answer names a prompt and includes the actor.
[Contract](../../packages/provider-contract/src/index.ts#L23-L178)

Enable capabilities for the exact agent and version, subject to machine policy.
Require a durable delivery ID before returning `accepted` or `duplicate`. A
confirmed write with no receipt is `in-doubt/best-effort`. A timeout after a
possible write is `in-doubt/unknown`. Do not retry either automatically.
Return `applied` for a control only on provider confirmation. Keep close and
ownership proof separate from the transport response.
[Contract rules](../../packages/provider-contract/README.md)

## Remaining dialects

### Terminal transcripts and paste

The daemon registers transcript watches. The watcher selects roots by agent,
and the parser selects the record format. Gemini, OpenCode, Cursor, pi, Muse,
and Antigravity use transcript paths today. Claude, Codex, and Grok also have
terminal sessions to observe.
[Daemon](../../apps/cli/src/daemon.ts#L37798),
[watcher](../../apps/cli/src/transcriptDirWatcher.ts#L86-L255),
[parser](../../apps/cli/src/parser.ts#L2547),
[Muse](../../apps/cli/src/museTranscript.ts),
[Antigravity](../../apps/cli/src/antigravityTranscript.ts)

Use one observed adapter with an injected transcript reader. Reuse the CLI
parsers at that boundary. Track file position, deduplicate by stable record ID,
and handle reopen and rotation. Emit only turn boundaries the transcript
supports. Start with reads, then add optional idle text paste. Check the pane
instance and fence at the write. A paste or a matching transcript line cannot
prove which inbox delivery the agent consumed. A terminal key cannot confirm
an interrupt for a named turn. Leave prompt answers and process lifecycle with
the existing paths. Closing observation releases its watch.
[Daemon paste](../../apps/cli/src/daemon.ts#L21642),
[tmux paste](../../apps/cli/src/tmuxPaste.ts#L263-L296),
[managed tmux](../../apps/cli/src/execution/drivers/managedTmux.ts#L282-L365)

Estimate 250–400 shared production lines plus 30–80 per transcript format.

### More ACP agents

The CLI's ACP implementation is Grok. It initializes the peer, loads sessions,
and routes requests and updates through the SDK host. The other candidates
currently use terminal transcripts.
[Grok client](../../apps/cli/src/grokAcp.ts#L108-L269),
[Grok session](../../apps/cli/src/claudeSdk/grokSession.ts#L121),
[SDK host](../../apps/cli/src/claudeSdk/host.ts#L102)

Reuse ACP framing, process ownership, and projection. Add a launch profile
with an exact version and tested capabilities for each agent. Start with
start, prompt, text, tools, and close. Add resume, control, and question
options as recordings prove them. An ACP prompt write gives no durable receipt.
A cancel notification gives no confirmation that a named turn was interrupted.
Reject mid-turn steer unless the peer can target the current turn.
[ACP adapter](../../packages/provider-adapter/src/acp-session.ts#L75),
[capabilities](../../packages/provider-contract/src/capabilities.ts)

Estimate 80–150 shared lines plus 30–90 per profile. Probe Gemini, OpenCode,
Cursor, then pi. Ship a version only if it passes Grok’s conformance suite.

### Cloud sessions

The registry selects a cloud client. The session service creates on first
delivery or sends a follow-up. The watcher polls and mirrors provider state.
Use the same cloud I/O behind a read-only adapter for one local mirror path.
Use stable remote IDs to deduplicate stream and REST backfill. Close the reader
without stopping remote work. Keep login, repo setup, and remote task creation
in the daemon. Today create takes the first prompt, while `StartSpec` has no
prompt. Keep cloud delivery on the existing path until the provider can open
an empty session or the contract defines how to pass initial input.
[Registry](../../apps/cli/src/cloudAgents/registry.ts#L137),
[delivery](../../apps/cli/src/cloudAgents/sessions.ts#L172),
[watcher](../../apps/cli/src/cloudAgents/watcher.ts#L161),
[streams](../../apps/cli/src/cloudAgents/streams.ts#L50)

1. Cursor Cloud has stream captures and run IDs. Start with one run's mirror.
   A run ID does not identify the inbox delivery. Use the exact expected run
   for any future owned cancel. The current client selects an active run.
   [Cursor client](../../apps/cli/src/cloudAgents/cursor.ts#L762-L812)
2. OpenAI Agents needs REST backfill after stream loss. Follow-up and cancel
   are session-scoped writes. A local read of active state cannot fence a
   remote turn change. Leave owned steer, receipts, and interrupt disabled
   until the provider supplies the needed evidence.
   [OpenAI Agents client](../../apps/cli/src/cloudAgents/openaiAgents.ts#L1135-L1171)
3. Codex Cloud can run parallel attempts. Keep attempt IDs in the mirror.
   Task-wide cancel cannot target one attempt. A successful follow-up gives
   no durable inbox receipt.
   [Codex Cloud client](../../apps/cli/src/cloudAgents/codex.ts#L1197-L1359)
4. Claude Cloud already polls history. Reuse the mirror. Follow-up sends a
   client UUID. Verify durable acceptance and recovery by that UUID before
   offering receipts. This client exposes no named-turn cancel.
   [Claude Cloud client](../../apps/cli/src/claudeCloud.ts#L324-L367),
   [mirror](../../apps/cli/src/claudeCloud.ts#L479)

Estimate 180–300 shared production lines plus 100–200 per cloud mirror.
Build terminal read and paste first, ACP profiles next, then cloud mirrors in
the order above. Pilot owned Codex in parallel with the terminal read work.

## Own one session behind a flag

Start with one fresh managed Codex app-server session at the pinned version.
Its fenced driver and journal already exist. Add a default-off pilot flag
under `CODECAST_FENCED_EXECUTION_V1`. Persist the driver choice in the pilot
binding across resume. Reuse auth, checkout, sandbox, and approval inputs.
[Registration](../../apps/cli/src/daemon.ts#L43857-L44040),
[driver](../../apps/cli/src/execution/drivers/codexAppServer.ts#L62-L232),
[runtime](../../apps/cli/src/execution/runtimeRail.ts#L275-L327)

Keep the split command handlers. Route start, resume, and stop through the
runtime. Route inbox steer through its coordinator and journal. Route interrupt
and prompt answers to the bound handle with the expected IDs. Keep terminal
I/O on its bridge. Record `in-doubt` as ambiguous, and require a durable
receipt for delivery success. The legacy driver uses the turn-start reply.
[Dispatch](../../apps/cli/src/daemon-commands/dispatch.ts#L49),
[start](../../apps/cli/src/daemon-commands/start-session.ts#L61), [resume](../../apps/cli/src/daemon-commands/resume-session.ts#L31), [stop](../../apps/cli/src/daemon-commands/session-lifecycle.ts#L12),
[coordinator](../../apps/cli/src/execution/coordinator.ts#L896-L1100),
[journal](../../apps/cli/src/execution/localJournal.ts#L326),
[terminal bridge](../../apps/cli/src/terminal/daemon-bridge.ts#L14-L85)

Emit `session.started` once. Add one canonical event sink for the pilot binding.
Persist the checkpoint with the last durable sequence and suppress legacy
event writers for that binding. Keep lease renewal in the runtime. At stop,
close the handle and prove cleanup before release or rollback. Leave uncertain
opens and deliveries in the journal for reconciliation.
[Legacy event hooks](../../apps/cli/src/daemon.ts#L43678-L43846),
[edge link](../../apps/cli/src/daemon-edge-link.ts#L48)

## Compare both paths offline

Run the legacy driver and pilot on separate fake processes with the same
recorded RPC frames and command schedule. Normalize generated IDs. Compare
ordered turns, messages, tools, prompts, results, and resume state. Check raw
frame retention, one event writer, and the receipt difference separately.
Replay mid-turn input, interrupt, approvals, exit, and late replies under
backpressure. Use fake tmux, ACP stdio, or HTTP/SSE for the other dialects.
[Legacy client tests](../../apps/cli/src/codexAppServer.test.ts#L980),
[fake app-server](../../packages/provider-adapter/test/fake-app-server.ts),
[recorded Codex items](../../apps/cli/src/__fixtures__/codexCloud/turns.ask.json)
