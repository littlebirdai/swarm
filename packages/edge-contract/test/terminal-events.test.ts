import { test } from "bun:test";
import { parseEventsAppendRequest } from "@codecast/edge-contract";
import { expectParsed, expectParseError } from "./assertions";
import fixture from "./fixtures/events.append.json";

const [batch] = fixture.request.batches;
const started = batch.events.find(
  (event) => event.kind === "terminal.started",
)!;
const ended = batch.events.find((event) => event.kind === "terminal.ended")!;
const maxId = "😀".repeat(128);
const lastPane = { pane_instance: Number.MAX_SAFE_INTEGER, started_run: 3 };
const manualPane = {
  pane_instance: lastPane.pane_instance,
  actor: { kind: "person", id: maxId },
};

test.each([
  ["a start without a tool call", { ...started, turn: null, body: manualPane }],
  [
    "a tool call ID at the limit",
    { ...started, body: { ...started.body, tool_call_id: maxId } },
  ],
  [
    "a signal",
    {
      ...ended,
      body: { ...lastPane, outcome: { kind: "signal", signal: "SIGTERM" } },
    },
  ],
  [
    "a system signal name with an offset",
    {
      ...ended,
      body: { ...lastPane, outcome: { kind: "signal", signal: "SIGRTMIN+1" } },
    },
  ],
  [
    "a replacement reported under a new run claim",
    { ...ended, run: 4, body: { ...lastPane, outcome: { kind: "replaced" } } },
  ],
  [
    "a lost pane without a start in the batch",
    { ...ended, body: { ...lastPane, outcome: { kind: "lost" } } },
  ],
])("events.append accepts %s", (_name, event) => {
  const request = {
    v: 1,
    batches: [{ ...batch, run: event.run, events: [event] }],
  };
  expectParsed(parseEventsAppendRequest(request), request);
});

test.each([
  [
    "a missing pane instance",
    started,
    { actor: manualPane.actor },
    "missing_field",
    "pane_instance",
  ],
  [
    "a zero pane instance",
    started,
    { ...manualPane, pane_instance: 0 },
    "invalid_value",
    "pane_instance",
  ],
  [
    "an unsafe pane instance",
    ended,
    { ...ended.body, pane_instance: Number.MAX_SAFE_INTEGER + 1 },
    "invalid_value",
    "pane_instance",
  ],
  ["a missing actor", started, { pane_instance: 4 }, "missing_field", "actor"],
  [
    "an unknown actor kind",
    started,
    { ...manualPane, actor: { kind: "daemon", id: "machine-1" } },
    "invalid_value",
    "actor.kind",
  ],
  [
    "a blank actor ID",
    started,
    { ...manualPane, actor: { ...manualPane.actor, id: "  " } },
    "invalid_value",
    "actor.id",
  ],
  [
    "an oversized actor ID",
    started,
    { ...manualPane, actor: { ...manualPane.actor, id: `${maxId}1` } },
    "invalid_value",
    "actor.id",
  ],
  [
    "a blank tool call ID",
    started,
    { ...manualPane, tool_call_id: "  " },
    "invalid_value",
    "tool_call_id",
  ],
  [
    "an oversized tool call ID",
    started,
    { ...manualPane, tool_call_id: `${maxId}1` },
    "invalid_value",
    "tool_call_id",
  ],
  [
    "an outcome on a start",
    started,
    { ...manualPane, outcome: { kind: "lost" } },
    "unknown_field",
    "outcome",
  ],
  [
    "an end without the run of its start",
    ended,
    { pane_instance: 4, outcome: { kind: "lost" } },
    "missing_field",
    "started_run",
  ],
  [
    "a zero run of the start",
    ended,
    { ...lastPane, started_run: 0, outcome: { kind: "lost" } },
    "invalid_value",
    "started_run",
  ],
  ["a missing end outcome", ended, lastPane, "missing_field", "outcome"],
  [
    "an unknown end outcome",
    ended,
    { ...lastPane, outcome: { kind: "failed" } },
    "invalid_value",
    "outcome.kind",
  ],
  [
    "a missing exit code",
    ended,
    { ...lastPane, outcome: { kind: "exit" } },
    "missing_field",
    "outcome.code",
  ],
  [
    "a negative exit code",
    ended,
    { ...lastPane, outcome: { kind: "exit", code: -1 } },
    "invalid_value",
    "outcome.code",
  ],
  [
    "a signal number",
    ended,
    { ...lastPane, outcome: { kind: "signal", signal: 15 } },
    "invalid_type",
    "outcome.signal",
  ],
  [
    "an unknown signal name",
    ended,
    { ...lastPane, outcome: { kind: "signal", signal: "TERM; rm" } },
    "invalid_value",
    "outcome.signal",
  ],
  [
    "an oversized signal name",
    ended,
    {
      ...lastPane,
      outcome: { kind: "signal", signal: "SIG" + "A".repeat(30) },
    },
    "invalid_value",
    "outcome.signal",
  ],
  [
    "a signal on an exit outcome",
    ended,
    { ...lastPane, outcome: { kind: "exit", code: 0, signal: "SIGTERM" } },
    "unknown_field",
    "outcome.signal",
  ],
  [
    "a command in a start event",
    started,
    { ...manualPane, command: "example command" },
    "unknown_field",
    "command",
  ],
  [
    "environment data in an end event",
    ended,
    { ...ended.body, env: { EXAMPLE: "value" } },
    "unknown_field",
    "env",
  ],
  [
    "a starter actor on an end",
    ended,
    { ...ended.body, actor: manualPane.actor },
    "unknown_field",
    "actor",
  ],
  [
    "a tool call ID on an end",
    ended,
    { ...ended.body, tool_call_id: "call-1" },
    "unknown_field",
    "tool_call_id",
  ],
  [
    "screen text in an end outcome",
    ended,
    { ...lastPane, outcome: { kind: "lost", screen: "pane output" } },
    "unknown_field",
    "outcome.screen",
  ],
  [
    "an extra actor field",
    started,
    { ...manualPane, actor: { ...manualPane.actor, text: "extra" } },
    "unknown_field",
    "actor.text",
  ],
] as const)("events.append rejects %s", (_name, event, body, code, path) => {
  const result = parseEventsAppendRequest({
    v: 1,
    batches: [{ ...batch, events: [{ ...event, body }] }],
  });
  expectParseError(result, code, `$.batches[0].events[0].body.${path}`);
});
