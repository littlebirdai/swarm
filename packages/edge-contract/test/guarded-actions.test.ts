import { expect, test } from "bun:test";
import * as edge from "@codecast/edge-contract";
import commandsNext from "./fixtures/commands.next.json";
import commandsResult from "./fixtures/commands.result.json";
import deliverySettle from "./fixtures/delivery.settle.json";
import guarded from "./fixtures/guarded-actions.json";
import hello from "./fixtures/hello.json";
import permitsNext from "./fixtures/permits.next.json";
import promptOpened from "./fixtures/prompt.opened.json";
import { expectParsed, expectParseError } from "./assertions";

const permit = { ...permitsNext.response, ...guarded.steer };
const staleSteer = { ...deliverySettle.request, ...guarded.stale_steer };
const { output: _output, ...commandResult } = commandsResult.request;

test("hello accepts the expected capability and older capability lists", () => {
  expect(hello.request.capabilities).toContain(edge.EXPECTED_CAPABILITY);
  const old = { ...hello.request, capabilities: ["delivery-permit-v1"] };
  expectParsed(edge.parseHelloRequest(old), old);
  expectParseError(
    edge.parseHelloRequest({ ...hello.request, capabilities: [false] }),
    "invalid_type",
    "$.capabilities[0]",
  );
});

test("responses preserve each guard and ignore additive guard fields", () => {
  expectParsed(
    edge.parsePermitsNextResponse({
      ...permit,
      expected: { ...permit.expected, future: true },
    }),
    permit,
  );
  const betweenTurns = {
    ...permitsNext.response,
    expected: { kind: "turn", turn: null },
  };
  expectParsed(edge.parsePermitsNextResponse(betweenTurns), betweenTurns);
  for (const fields of guarded.commands) {
    const command = { ...commandsNext.response, ...fields };
    expectParsed(
      edge.parseCommandsNextResponse({
        ...command,
        expected: { ...command.expected, future: true },
      }),
      command,
    );
  }
});

test("responses reject malformed guards", () => {
  expectParseError(
    edge.parsePermitsNextResponse({
      ...permit,
      expected: guarded.commands[1].expected,
    }),
    "invalid_value",
    "$.expected.kind",
  );
  expectParseError(
    edge.parsePermitsNextResponse({ ...permit, expected: { kind: "turn" } }),
    "missing_field",
    "$.expected.turn",
  );
  const malformed = [
    [null, "invalid_type", "$.expected"],
    [{ kind: "other" }, "invalid_value", "$.expected.kind"],
    [{ kind: "turn", turn: "" }, "invalid_value", "$.expected.turn"],
    [
      { kind: "prompt", run: 0, prompt_id: "prompt-1" },
      "invalid_value",
      "$.expected.run",
    ],
    [
      { kind: "prompt", run: 3, prompt_id: null },
      "invalid_type",
      "$.expected.prompt_id",
    ],
    [
      { kind: "terminal", pane_instance: 4, fencing_token: "17" },
      "missing_field",
      "$.expected.run",
    ],
    [
      { kind: "terminal", run: null, pane_instance: 4, fencing_token: "17" },
      "invalid_type",
      "$.expected.run",
    ],
    [
      { kind: "terminal", run: 3, pane_instance: 0, fencing_token: "17" },
      "invalid_value",
      "$.expected.pane_instance",
    ],
    [
      { kind: "terminal", run: 3, pane_instance: 1, fencing_token: 17 },
      "invalid_type",
      "$.expected.fencing_token",
    ],
  ] as const;
  for (const [expected, code, path] of malformed) {
    expectParseError(
      edge.parseCommandsNextResponse({ ...commandsNext.response, expected }),
      code,
      path,
    );
  }
});

test("stale requests report the turn, prompt, pane, or absence seen by the machine", () => {
  expectParsed(edge.parseDeliverySettleRequest(staleSteer), staleSteer);
  for (const fields of guarded.stale_commands) {
    const result = { ...commandResult, ...fields };
    expectParsed(edge.parseCommandsResultRequest(result), result);
  }
});

test("stale requests require strict observations on the stale variant only", () => {
  expectParseError(
    edge.parseDeliverySettleRequest({
      ...deliverySettle.request,
      outcome: "stale",
    }),
    "missing_field",
    "$.observed",
  );
  expectParseError(
    edge.parseDeliverySettleRequest({
      ...staleSteer,
      observed: { kind: "prompt", turn: null },
    }),
    "invalid_value",
    "$.observed.kind",
  );
  expectParseError(
    edge.parseDeliverySettleRequest({ ...staleSteer, outcome: "applied" }),
    "unknown_field",
    "$.observed",
  );
  expectParseError(
    edge.parseDeliverySettleRequest({
      ...staleSteer,
      resolution_evidence: "no effect",
    }),
    "invalid_value",
    "$.outcome",
  );
  const staleCommand = { ...commandResult, outcome: "stale" };
  expectParseError(
    edge.parseCommandsResultRequest(staleCommand),
    "missing_field",
    "$.observed",
  );
  const malformed = [
    [{ kind: "turn", turn: 1 }, "invalid_type", "$.observed.turn"],
    [
      { kind: "turn", turn: null, extra: true },
      "unknown_field",
      "$.observed.extra",
    ],
    [
      { kind: "prompt", run: 0, prompt_id: null },
      "invalid_value",
      "$.observed.run",
    ],
    [{ kind: "prompt", run: 1 }, "missing_field", "$.observed.prompt_id"],
    [
      { kind: "terminal", pane_instance: null, fencing_token: null },
      "missing_field",
      "$.observed.run",
    ],
    [
      { kind: "terminal", run: 0, pane_instance: null, fencing_token: null },
      "invalid_value",
      "$.observed.run",
    ],
    [
      { kind: "terminal", run: 3, pane_instance: 0, fencing_token: null },
      "invalid_value",
      "$.observed.pane_instance",
    ],
    [
      { kind: "terminal", run: 3, pane_instance: 4, fencing_token: 17 },
      "invalid_type",
      "$.observed.fencing_token",
    ],
  ] as const;
  for (const [observed, code, path] of malformed) {
    expectParseError(
      edge.parseCommandsResultRequest({ ...staleCommand, observed }),
      code,
      path,
    );
  }
  expectParseError(
    edge.parseCommandsResultRequest({
      ...commandsResult.request,
      observed: { kind: "turn", turn: null },
    }),
    "unknown_field",
    "$.observed",
  );
});

test("stale delivery settlements reject retryable and extra fields", () => {
  for (const [field, value] of [
    ["retryable", true],
    ["extra", 1],
  ] as const) {
    expectParseError(
      edge.parseDeliverySettleRequest({ ...staleSteer, [field]: value }),
      "unknown_field",
      `$.${field}`,
    );
  }
});

test("stale command results reject output and extra fields", () => {
  const staleCommand = { ...commandResult, ...guarded.stale_commands[0] };
  for (const [field, value] of [
    ["output", null],
    ["extra", 1],
  ] as const) {
    expectParseError(
      edge.parseCommandsResultRequest({ ...staleCommand, [field]: value }),
      "unknown_field",
      `$.${field}`,
    );
  }
});

const turn = { kind: "turn", turn: "turn-1" } as const;
const prompt = { kind: "prompt", run: 3, prompt_id: "prompt-1" } as const;
const terminal = {
  kind: "terminal",
  run: 3,
  pane_instance: 4,
  fencing_token: "17",
} as const;

test.each([
  ["steer on a replaced turn", turn, { ...turn, turn: "turn-2" }],
  ["interrupt after a turn ends", turn, { ...turn, turn: null }],
  ["steer from idle after a turn starts", { ...turn, turn: null }, turn],
  ["answer after a prompt ID is reused", prompt, { ...prompt, run: 4 }],
  [
    "answer after another prompt opens",
    prompt,
    { ...prompt, prompt_id: "prompt-2" },
  ],
  ["answer after a prompt closes", prompt, { ...prompt, prompt_id: null }],
  ["answer when there is no active run", prompt, { ...prompt, run: null }],
  ["input after a pane restarts", terminal, { ...terminal, pane_instance: 5 }],
  [
    "input to the same pane number in another run",
    terminal,
    { ...terminal, run: 4 },
  ],
  [
    "input without an observed pane",
    terminal,
    { ...terminal, pane_instance: null },
  ],
  [
    "input with a newer lease token",
    { ...terminal, fencing_token: "18" },
    terminal,
  ],
  [
    "input after the typing lease changes",
    terminal,
    { ...terminal, fencing_token: "18" },
  ],
  [
    "input after the typing lease ends",
    terminal,
    { ...terminal, fencing_token: null },
  ],
] as const)("%s cannot take effect", (_action, expected, observed) => {
  expect(edge.matchesExpected(expected, observed)).toBe(false);
});

test("current and unguarded actions can take effect", () => {
  for (const current of [
    turn,
    prompt,
    terminal,
    { kind: "turn", turn: null },
  ] as const) {
    expect(edge.matchesExpected(current, current)).toBe(true);
  }
  expect(edge.matchesExpected(undefined, { kind: "turn", turn: null })).toBe(
    true,
  );
  expect(edge.matchesExpected(turn, prompt)).toBe(false);
});

test("prompt events preserve optional details and default to escalation", () => {
  const bare = { prompt_id: "prompt-1", kind: "permission" };
  const event = { ...promptOpened, body: bare };
  expectParsed(edge.parseCanonicalEvent(event), event);
  expectParsed(edge.parseCanonicalEvent(promptOpened), promptOpened);
  expect(edge.classifyPrompt(bare, "workspace_read")).toBe("escalation");
  expect(edge.classifyPrompt(promptOpened.body)).toBe("escalation");
  expect(edge.classifyPrompt(promptOpened.body, "workspace_read")).toBe(
    "routine",
  );
  expect(
    edge.classifyPrompt(
      {
        ...promptOpened.body,
        rule_request: { ...promptOpened.body.rule_request, opaque: true },
      },
      "workspace_read",
    ),
  ).toBe("escalation");
  expect(
    edge.classifyPrompt(
      {
        ...promptOpened.body,
        rule_request: { ...promptOpened.body.rule_request, permission: "edit" },
      },
      "workspace_read",
    ),
  ).toBe("escalation");
});

test("a verified question needs a summary and escalates an opaque request", () => {
  const bare = { prompt_id: "prompt-1", kind: "question" };
  const question = { ...bare, summary: "Choose a title" };
  const rule = { permission: "askuserquestion", patterns: ["*"], always: [] };
  expect(edge.classifyPrompt(bare, "question")).toBe("escalation");
  expect(edge.classifyPrompt(question)).toBe("escalation");
  expect(edge.classifyPrompt(question, "question")).toBe("routine");
  expect(
    edge.classifyPrompt({ ...question, rule_request: rule }, "question"),
  ).toBe("routine");
  expect(
    edge.classifyPrompt(
      {
        ...question,
        rule_request: { ...rule, opaque: true },
      },
      "question",
    ),
  ).toBe("escalation");
});

test("a verification for another kind of prompt escalates", () => {
  const question = { prompt_id: "p1", kind: "question", summary: "Choose" };
  for (const kind of ["permission", "plan"])
    expect(edge.classifyPrompt({ ...question, kind }, "question")).toBe(
      "escalation",
    );
  expect(edge.classifyPrompt({ ...question, summary: " " }, "question")).toBe(
    "escalation",
  );
  for (const kind of ["question", "plan"])
    expect(
      edge.classifyPrompt({ ...promptOpened.body, kind }, "workspace_read"),
    ).toBe("escalation");
});

test("a verified workspace read needs its tool call and tool name", () => {
  for (const field of ["tool_call_id", "tool_name"])
    expect(
      edge.classifyPrompt(
        { ...promptOpened.body, [field]: undefined },
        "workspace_read",
      ),
    ).toBe("escalation");
});

test("only an opaque request with one pattern carries a long pattern", () => {
  const long = "x".repeat(1_001);
  const rule = {
    permission: "bash",
    patterns: [long],
    always: [],
    opaque: true,
  };
  const parse = (rule_request: object) =>
    edge.parseCanonicalEvent({
      ...promptOpened,
      body: { ...promptOpened.body, rule_request },
    }).ok;
  expect(parse(rule)).toBe(true);
  expect(parse({ ...rule, patterns: [long, "a"] })).toBe(false);
  expect(parse({ ...rule, always: ["a"] })).toBe(false);
});

test("a verified workspace read needs a nonempty list of non-blank patterns", () => {
  const { rule_request, ...body } = promptOpened.body;
  for (const patterns of [[], ["notes.txt", ""], ["notes.txt", " \t"]]) {
    expect(
      edge.classifyPrompt(
        {
          ...body,
          rule_request: { ...rule_request, patterns },
        },
        "workspace_read",
      ),
    ).toBe("escalation");
  }
});

test("prompt details reject wrong types, excess lengths, and unknown request fields", () => {
  const rule = promptOpened.body.rule_request;
  const malformed = [
    [{ class: "routine" }, "unknown_field", "$.body.class"],
    [{ tool_call_id: "" }, "invalid_value", "$.body.tool_call_id"],
    [{ tool_call_id: "x".repeat(257) }, "invalid_value", "$.body.tool_call_id"],
    [{ tool_name: true }, "invalid_type", "$.body.tool_name"],
    [{ tool_name: "x".repeat(129) }, "invalid_value", "$.body.tool_name"],
    [{ summary: "line one\nline two" }, "invalid_value", "$.body.summary"],
    [{ summary: "x".repeat(501) }, "invalid_value", "$.body.summary"],
    [{ rule_request: null }, "invalid_type", "$.body.rule_request"],
    [
      { rule_request: { ...rule, opaque: "true" } },
      "invalid_type",
      "$.body.rule_request.opaque",
    ],
    [
      { rule_request: { ...rule, permission: "x".repeat(81) } },
      "invalid_value",
      "$.body.rule_request.permission",
    ],
    [
      { rule_request: { ...rule, patterns: [1] } },
      "invalid_type",
      "$.body.rule_request.patterns[0]",
    ],
    [
      { rule_request: { ...rule, patterns: Array(33).fill("foo") } },
      "invalid_value",
      "$.body.rule_request.patterns",
    ],
    [
      { rule_request: { ...rule, patterns: ["x".repeat(1001)] } },
      "invalid_value",
      "$.body.rule_request.patterns",
    ],
    [
      { rule_request: { ...rule, always: Array(9).fill("foo") } },
      "invalid_value",
      "$.body.rule_request.always",
    ],
    [
      { rule_request: { ...rule, always: ["x".repeat(1001)] } },
      "invalid_value",
      "$.body.rule_request.always[0]",
    ],
    [
      { rule_request: { ...rule, extra: true } },
      "unknown_field",
      "$.body.rule_request.extra",
    ],
    [{ summary: " \t" }, "invalid_value", "$.body.summary"],
  ] as const;
  for (const [fields, code, path] of malformed) {
    const event = {
      ...promptOpened,
      body: { ...promptOpened.body, ...fields },
    };
    expectParseError(edge.parseCanonicalEvent(event), code, path);
  }
  const opaque = {
    ...promptOpened,
    body: {
      ...promptOpened.body,
      rule_request: {
        ...rule,
        opaque: true,
        patterns: ["x".repeat(32_000)],
        always: [],
      },
    },
  };
  expectParsed(edge.parseCanonicalEvent(opaque), opaque);
});

test("prompt events accept opaque requests with empty patterns from the rule builder", () => {
  const event = {
    ...promptOpened,
    body: {
      ...promptOpened.body,
      tool_name: "Glob",
      rule_request: {
        permission: "read",
        patterns: ["", "../*.txt"],
        always: [],
        opaque: true,
      },
    },
  };
  expectParsed(edge.parseCanonicalEvent(event), event);
  expect(edge.classifyPrompt(event.body, "workspace_read")).toBe("escalation");
});
