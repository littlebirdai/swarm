# Provider adapter cutover

Main supports owned Grok over ACP and Codex 0.153.4 over app-server.
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
[Daemon](../../apps/cli/src/daemon.ts#L37798), [watcher](../../apps/cli/src/transcriptDirWatcher.ts#L86-L255), [parser](../../apps/cli/src/parser.ts#L2547), [Muse](../../apps/cli/src/museTranscript.ts), [Antigravity](../../apps/cli/src/antigravityTranscript.ts)

Use one observed adapter with an injected transcript reader. Reuse the CLI
parsers at that boundary. Track file position, deduplicate by stable record ID,
and handle reopen and rotation. Emit only turn boundaries the transcript
supports. Start with reads, then add optional idle text paste. Check the pane
instance and fence at the write. A paste or a matching transcript line cannot
prove which inbox delivery the agent consumed. A terminal key cannot confirm
an interrupt for a named turn. Leave prompt answers and process lifecycle with
the existing paths. Closing observation releases its watch.
[Daemon paste](../../apps/cli/src/daemon.ts#L21642), [tmux paste](../../apps/cli/src/tmuxPaste.ts#L263-L296), [managed tmux](../../apps/cli/src/execution/drivers/managedTmux.ts#L282-L365)

Estimate 250–400 shared production lines plus 30–80 per transcript format.

### More ACP agents

The CLI's ACP implementation is Grok. It initializes the peer, loads sessions,
and routes requests and updates through the SDK host. The other candidates
currently use terminal transcripts.
[Grok client](../../apps/cli/src/grokAcp.ts#L108-L269), [Grok session](../../apps/cli/src/claudeSdk/grokSession.ts#L121), [SDK host](../../apps/cli/src/claudeSdk/host.ts#L102)

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
[Registry](../../apps/cli/src/cloudAgents/registry.ts#L137), [delivery](../../apps/cli/src/cloudAgents/sessions.ts#L172), [watcher](../../apps/cli/src/cloudAgents/watcher.ts#L161), [streams](../../apps/cli/src/cloudAgents/streams.ts#L50)

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
Set `CODECAST_CODEX_OWNED_PILOT_SESSION` to the ID of one fresh managed
conversation to select it for this pilot. The ready binding keeps the provider
checkpoint and the launch policy. The event writer claims the run after the
binding is ready and resumes at the last sequence confirmed by the server.
The owned binding drains its inbox through the edge delivery routes.
[Registration](../../apps/cli/src/daemon.ts#L43857-L44040), [driver](../../apps/cli/src/execution/drivers/codexAppServer.ts#L62-L232), [runtime](../../apps/cli/src/execution/runtime-rail.ts#L275-L327)

Keep the split handlers and terminal I/O bridge. Emit `session.started` once.
Use one event writer. Save the checkpoint and last durable sequence. Renew
the lease and prove cleanup before release or rollback.
[Dispatch](../../apps/cli/src/daemon-commands/dispatch.ts#L49), [journal](../../apps/cli/src/execution/local-journal.ts#L326), [terminal bridge](../../apps/cli/src/terminal/daemon-bridge.ts#L14-L85), [edge link](../../apps/cli/src/daemon-edge-link.ts#L48)

### Pilot bridges

- **Delivery.** The pilot reads and starts the exact server permit before sending. An in-doubt result holds the coordinator slot and ends the drain. Only the server's settlement or a confirmed change to the queue head releases the slot. The poll reads the server for authority. [Pilot delivery](../../apps/cli/src/execution/codex-pilot-delivery.ts), [coordinator](../../apps/cli/src/execution/coordinator.ts), [runtime rail](../../apps/cli/src/execution/runtime-rail.ts)
- **Restart and controls.** Add runtime routes for checkpoint resume, interrupt, and answer. `RuntimeDriver` has none. Codex `adopt` checks a live in-memory registration and cannot restore a thread after restart on its own. Prove the previous boot ended, resume from the journal, and use the active-turn event with the journal or transcript for history. The adapter returns no historical turns. [Driver](../../apps/cli/src/execution/driver.ts#L21-L37), [boot fence](../../apps/cli/src/execution/coordinator.ts#L506-L547), [Codex inspection](../../apps/cli/src/daemon.ts#L43999-L44007), [adapter resume](../../packages/provider-adapter/src/app-server-session.ts#L199-L211)
- **Prompts.** Route permission decisions and question choices to the fenced prompt ID with the actor. Send structured answers by question ID. The old client grants permissions for the session, and the adapter grants them for one turn. [Legacy replies](../../apps/cli/src/codex-app-server.ts#L438-L465), [adapter replies](../../packages/provider-adapter/src/app-server-prompts.ts#L65-L110)
- **Events and display.** The owned pilot applies display effects after the edge acknowledges each durable event. It uses the daemon's status and title handlers and runs spawn tracking at tool start. Matching decoded frames supply the tool fields and structured error codes used by the legacy formatters. [Pilot registration](../../apps/cli/src/daemon.ts#L43855), [display projection](../../apps/cli/src/execution/codex-pilot-display.ts), [parity test](../../apps/cli/src/execution/codex-pilot-display.test.ts)
- **Launch and policy.** Apply `withWorktreeConfig` and pass stable developer instructions. Set `STABLE_ENV_MODE` to off and use the agent spawn path. Preserve auth refresh, policy invalidation, and sandbox state across resume. [Worktree](../../apps/cli/src/worktreeEnv.ts#L144), [instructions](../../apps/cli/src/daemon.ts#L34348), [spawn](../../apps/cli/src/codex-app-server.ts#L976-L997), [auth refresh](../../apps/cli/src/codex-app-server.ts#L584-L648) and [policy on resume](../../apps/cli/src/codex-app-server.ts#L785-L938), [invalidation](../../apps/cli/src/codex-app-server.ts#L850-L867)
- **Fork and Escape.** Keep fork on its existing route. Route Escape to the exact active turn and keep the press-time guard and queued-message release rules. [Fork](../../apps/cli/src/daemon-commands/resume-forks.ts#L181-L195), [Escape](../../apps/cli/src/daemon-commands/session-input.ts#L77-L186)

The start operation creates the checkpoint. After the edge grants the lease,
the pilot closes the provisional adapter and resumes the checkpoint with the
lease token before the first send. The event writer starts after that resume.

The adapter commits the delivery ID, provider item ID, and turn to the daemon's
local journal before it emits a receipt. An RPC acknowledgement or a text echo
alone leaves the delivery in doubt. After restart, the adapter replays the
receipt for the server's started attempt. The daemon appends the receipt and
reads that delivery's journal record as evidence for settlement. It removes the
record after the server confirms settlement. On restart, the fenced queue head
identifies the only delivery that can still need its receipt. The daemon keeps
that receipt and removes older records for the checkpoint. The adapter keeps up
to 128 recent receipts in memory and checks the journal for older retries.
[Journal](../../apps/cli/src/execution/local-journal.ts),
[adapter receipts](../../packages/provider-adapter/src/app-server-receipts.ts)

The pilot also requires `CODECAST_EDGE_DELIVERY_V1` on the server. Without a
completed Codex user item that echoes the client delivery ID, the server keeps
the attempt in doubt until it receives settlement evidence.

Keep steer permits disabled for the pilot until the server can settle a permit
whose expected turn has ended. The pilot leaves such a permit at the queue head
without sending it. The current settlement route refuses the `stale` outcome.

A pending successor waits for any started delivery on the owned run to settle.
The server still needs a route to record the disposition of a leased run after
provider cleanup. The current disposition mutation has no lease token input.
[Server disposition](../../apps/server/convex/executionBindings.ts#L3742)

## Compare both paths offline

Run `bun run --filter @codecast/test-codex-driver-parity test`. Two fake
app-servers replay the same recorded items. The suite normalizes IDs and
checks the known differences. The adapter buffers the 36-frame burst while
the reader is paused and settles interrupt. The legacy client delivers the
frames in order without backpressure. The CLI display test reuses the same
recording and adds provider frames for status, title, tool starts, images, MCP,
diffs and a failed turn.
[Display test](../../apps/cli/src/execution/codex-pilot-display.test.ts),
[recorded items](../../apps/cli/src/__fixtures__/codexCloud/turns.ask.json)

## Differences found

| Case                             | Legacy driver and client                                                                                               | Owned adapter                                                                                                                                                       | Verdict                                                                                                                                              |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start and resume handshake       | Sends `initialize` only.                                                                                               | Also sends `initialized`.                                                                                                                                           | Intended                                                                                                                                             |
| Idle send and late reply         | Marks delivery complete when the RPC returns.                                                                          | Returns `in-doubt/best-effort` when the RPC succeeds without a durable receipt.                                                                                     | The pilot waits for a receipt or a server settlement.                                                                                                |
| Mid-turn send                    | Calls `turn/start`. The fake rejects the busy request and the driver reports ambiguity.                                | Calls `turn/steer` for the expected turn.                                                                                                                           | The pilot requires a steer permit with the exact active turn.                                                                                        |
| User echoes                      | Omits echoed input from the final messages.                                                                            | Emits the user message. Correlates delivery receipts by the echoed client ID and stores the accepted item and turn in the daemon journal.                           | The pilot settles from the durable receipt. A text-only echo supplies transcript evidence.                                                           |
| Command approval                 | Sends accept or decline. There is no client settlement event.                                                          | Sends the same decision and records the actor in a settlement. The reply has no provider acknowledgement.                                                           | Must be bridged by the pilot                                                                                                                         |
| Question                         | Exposes the choices in the request. Sends empty answers through the boolean approval API.                              | Emits choice context and sends the selected answer.                                                                                                                 | Must be bridged by the pilot                                                                                                                         |
| Assistant delta                  | Emits item ID and text.                                                                                                | Also emits the text offset.                                                                                                                                         | Intended                                                                                                                                             |
| Reasoning                        | Groups reasoning with assistant text. Uses the summary when reasoning text is empty.                                   | The pilot restores the same grouping and summary fallback from the ordered context events.                                                                          | Covered for completed items                                                                                                                          |
| Thread status and names          | Forwards thread status and name changes. On a successful turn, it also consults the daemon's turn-end status resolver. | The pilot forwards provider status and names with the same daemon handlers. It reports working at turn start and idle after successful completion.                  | Waiting-state inference remains with the legacy resolver.                                                                                            |
| Spawn tracking                   | Tracks tmux spawns when the provider reports a started item.                                                           | The pilot calls the same tracker when the started item has a canonical tool call.                                                                                   | Covered for a recorded command start                                                                                                                 |
| Error banners                    | Uses the provider error code and message. Translates provider codes to banner types.                                   | The pilot restores the code from a matching decoded turn-completion notification and formats the canonical error message the same way.                              | The adapter can redact or truncate the message. An RPC-only failure without a matching notification uses the canonical message without the raw code. |
| Images, MCP names and file diffs | Extracts image markers, formats names as `server__tool`, and normalizes file diffs.                                    | The pilot reuses those formatters for decoded tool items matched to canonical events.                                                                               | Covered for completed items. The process-local tool cache retains up to 128 entries.                                                                 |
| Display timing and model         | Updates the transcript as items and partial text arrive. Adds the resolved model when available.                       | Publishes the completed transcript batch at turn end and tags it with the requested model when present. Status, title and spawn effects run as their events arrive. | Partial transcript updates and the provider's resolved model remain open.                                                                            |
| Duplicate late reply             | Emits no second turn.                                                                                                  | Emits no second turn and retains the duplicate as an unknown raw frame.                                                                                             | Intended                                                                                                                                             |
| Process exit                     | Emits process exit. The shared client owns restart.                                                                    | Ends the turn and the owned session. The machine owns recovery.                                                                                                     | Must be bridged by the pilot                                                                                                                         |
| Resume state                     | Returns historical and active turns to the caller.                                                                     | Returns the checkpoint and emits the resumed active turn start.                                                                                                     | Must be bridged by the pilot                                                                                                                         |
| Completion after resume          | `turnCompleted` has no final messages. `itemStarted` is suppressed. `itemCompleted` still fires.                       | Emits the resumed messages and tools before the result.                                                                                                             | Legacy defect                                                                                                                                        |

On legacy recovery, a queued follow-up skips seeding the turn's progress.
The live item handler drops those completions, and the final callback has no
messages for the turn.
[Recovery](../../apps/cli/src/daemon.ts#L26013-L26049), [item handler](../../apps/cli/src/daemon.ts#L43730-L43753), [client accumulator](../../apps/cli/src/codex-app-server.ts#L1261-L1323)
