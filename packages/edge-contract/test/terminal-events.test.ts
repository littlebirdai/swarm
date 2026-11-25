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
const manualPane = {
  pane_instance: Number.MAX_SAFE_INTEGER,
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
      body: { ...manualPane, outcome: { kind: "signal", signal: 15 } },
    },
  ],
  [
    "a replacement",
    { ...ended, body: { ...manualPane, outcome: { kind: "replaced" } } },
  ],
  [
    "a lost pane",
    { ...ended, body: { ...manualPane, outcome: { kind: "lost" } } },
  ],
])("events.append accepts %s", (_name, event) => {
  const request = { v: 1, batches: [{ ...batch, events: [event] }] };
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
    ended,
    { ...ended.body, tool_call_id: `${maxId}1` },
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
  ["a missing end outcome", ended, manualPane, "missing_field", "outcome"],
  [
    "an unknown end outcome",
    ended,
    { ...manualPane, outcome: { kind: "failed" } },
    "invalid_value",
    "outcome.kind",
  ],
  [
    "a missing exit code",
    ended,
    { ...manualPane, outcome: { kind: "exit" } },
    "missing_field",
    "outcome.code",
  ],
  [
    "a negative exit code",
    ended,
    { ...manualPane, outcome: { kind: "exit", code: -1 } },
    "invalid_value",
    "outcome.code",
  ],
  [
    "a string signal",
    ended,
    { ...manualPane, outcome: { kind: "signal", signal: "SIGTERM" } },
    "invalid_type",
    "outcome.signal",
  ],
  [
    "a zero signal",
    ended,
    { ...manualPane, outcome: { kind: "signal", signal: 0 } },
    "invalid_value",
    "outcome.signal",
  ],
  [
    "a signal on an exit outcome",
    ended,
    { ...manualPane, outcome: { kind: "exit", code: 0, signal: 15 } },
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
    "screen text in an end outcome",
    ended,
    { ...manualPane, outcome: { kind: "lost", screen: "pane output" } },
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
