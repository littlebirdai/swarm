import { test } from "bun:test";
import assert from "node:assert/strict";
import { createReducer, reducer } from "./messageReducer";

test("processes user and assistant messages in order", () => {
  const state = createReducer();
  const messages = [
    {
      _id: "msg1",
      message_uuid: "uuid1",
      role: "user",
      content: "Hello",
      timestamp: 1000,
    },
    {
      _id: "msg2",
      message_uuid: "uuid2",
      role: "assistant",
      content: "Hi there!",
      timestamp: 2000,
    },
  ];

  const processed = reducer(state, messages);
  assert.ok(processed.length === 2, "Should have 2 messages");
  assert.ok(processed[0].role === "user", "First should be user");
  assert.ok(processed[1].role === "assistant", "Second should be assistant");
});

test("joins a tool call to its result", () => {
  const state = createReducer();
  const messages = [
    {
      _id: "msg3",
      message_uuid: "uuid3",
      role: "assistant",
      content: "Let me read that file",
      timestamp: 3000,
      tool_calls: [
        {
          id: "tool1",
          name: "Read",
          input: JSON.stringify({ file_path: "/test.txt" }),
        },
      ],
    },
    {
      _id: "msg4",
      message_uuid: "uuid4",
      role: "user",
      timestamp: 4000,
      tool_results: [
        {
          tool_use_id: "tool1",
          content: "file contents here",
          is_error: false,
        },
      ],
    },
  ];

  const processed = reducer(state, messages);
  assert.ok(processed.length === 2, "Should have 2 messages (text + tool)");

  const toolMessage = processed.find((m) => m.tool);
  assert.ok(toolMessage !== undefined, "Should have tool message");
  assert.ok(
    toolMessage!.tool!.state === "completed",
    "Tool should be completed",
  );
  assert.ok(
    toolMessage!.tool!.result === "file contents here",
    "Should have result",
  );
});

test("extracts the latest TodoWrite list", () => {
  const state = createReducer();
  const messages = [
    {
      _id: "msg5",
      message_uuid: "uuid5",
      role: "assistant",
      timestamp: 5000,
      tool_calls: [
        {
          id: "tool2",
          name: "TodoWrite",
          input: JSON.stringify({
            todos: [
              { content: "Task 1", status: "pending", activeForm: "Task 1" },
              {
                content: "Task 2",
                status: "in_progress",
                activeForm: "Task 2",
              },
            ],
          }),
        },
      ],
    },
  ];

  reducer(state, messages);
  assert.ok(state.latestTodos !== undefined, "Should have todos");
  assert.ok(state.latestTodos!.todos.length === 2, "Should have 2 todos");
});

test("deduplicates messages by UUID", () => {
  const state = createReducer();
  const messages = [
    {
      _id: "msg6",
      message_uuid: "uuid6",
      role: "user",
      content: "Hello",
      timestamp: 6000,
    },
    {
      _id: "msg7",
      message_uuid: "uuid6",
      role: "user",
      content: "Hello",
      timestamp: 6000,
    },
  ];

  const processed = reducer(state, messages);
  assert.ok(processed.length === 1, "Should deduplicate by UUID");
});

test("buffers a tool result until its call arrives", () => {
  const state = createReducer();

  const orphanResult = [
    {
      _id: "msg8",
      message_uuid: "uuid8",
      role: "user",
      timestamp: 7000,
      tool_results: [
        {
          tool_use_id: "tool3",
          content: "result from the future!",
          is_error: false,
        },
      ],
    },
  ];

  const beforeCall = reducer(state, orphanResult);
  assert.ok(
    beforeCall.length === 0,
    "Should not create message for orphan result",
  );
  assert.ok(
    state.orphanToolResults.has("tool3"),
    "Should buffer orphan result",
  );

  const toolCall = [
    {
      _id: "msg9",
      message_uuid: "uuid9",
      role: "assistant",
      content: "Reading file...",
      timestamp: 8000,
      tool_calls: [
        {
          id: "tool3",
          name: "Read",
          input: JSON.stringify({ file_path: "/test.txt" }),
        },
      ],
    },
  ];

  const afterCall = reducer(state, toolCall);
  assert.ok(afterCall.length === 2, "Should have text + tool messages");

  const toolMessage = afterCall.find((m) => m.tool);
  assert.ok(toolMessage !== undefined, "Should have tool message");
  assert.ok(
    toolMessage!.tool!.state === "completed",
    "Tool should be completed immediately",
  );
  assert.ok(
    toolMessage!.tool!.result === "result from the future!",
    "Should have orphan result",
  );
  assert.ok(
    !state.orphanToolResults.has("tool3"),
    "Should clean up orphan after processing",
  );
});
