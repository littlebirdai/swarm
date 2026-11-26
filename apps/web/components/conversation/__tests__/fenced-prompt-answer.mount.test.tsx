import { expect, test } from "bun:test";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { ConvexError } from "convex/values";
import { act } from "react";
import { mountWeb } from "../../../test-helpers/mountWeb";
import { expectToast } from "../../../test-helpers/expectToast";
import type { FencedPromptAddress } from "../../../store/fenced-prompt-answer";
import { DispatchFailureToast } from "../../dispatch-failure-toast";
import { PermissionCard } from "../../permission-card";
import { TeamProposalContext } from "../../../hooks/useTeamProposals";
import { AskUserQuestionBlock } from "../blocks/interactive-blocks";
import { ModernAskUserQuestion } from "../blocks/modern-ask-user-question";
import { AssistantBlock } from "../blocks/turnBlocks";
import { useDecisionAnswer } from "../../../hooks/useDecisionAnswer";

const conversationId = "a".repeat(32) as Id<"conversations">;
const leaseId = "b".repeat(32) as Id<"run_leases">;
const permissionId = "c".repeat(32) as Id<"pending_permissions">;
const questionId = "native-question";
const promptId = "provider-question-tool";
const permissionPromptId = "1:app-server:string:approval";
const refusal =
  "The prompt has closed or you no longer have permission to answer it.";
const query = api.permissions.listAnswerablePromptAddresses;

function address(
  prompt_id = promptId,
  kind: FencedPromptAddress["kind"] = "question",
  turn_id = "turn",
): FencedPromptAddress {
  return {
    _id: JSON.stringify([leaseId, turn_id, prompt_id]),
    conversation_id: conversationId,
    lease_id: leaseId,
    run: 1,
    turn_id,
    prompt_id,
    kind,
    questions:
      kind === "question" ? [{ id: questionId, is_secret: false }] : [],
  };
}

function Question(props: {
  legacySend: (payload: string) => void;
  old?: boolean;
  secret?: boolean;
}) {
  const input = {
    ...(props.old ? {} : { fencedTurnId: "turn" }),
    questions: [
      {
        id: questionId,
        question: "Which output do you want?",
        isSecret: props.secret,
        options: [
          { label: props.old ? "Short" : "Short (Recommended)" },
          { label: "Full" },
        ],
      },
    ],
  };
  const tool = {
    id: props.old ? "old-tool" : promptId,
    name: "AskUserQuestion",
    input: JSON.stringify(input),
  };
  return props.old ? (
    <ModernAskUserQuestion
      conversationId={conversationId}
      tool={tool}
      onSendMessage={props.legacySend}
      parsedInput={input}
    />
  ) : (
    <TeamProposalContext.Provider
      value={{ conversationId, role: "owner", ownerName: "Owner" }}
    >
      <AskUserQuestionBlock tool={tool} onSendMessage={props.legacySend} />
    </TeamProposalContext.Provider>
  );
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Button ${label} is missing`);
  return found;
}

test("a question is answered optimistically and a double click sends its exact address once", async () => {
  const old: string[] = [];
  const gate = Promise.withResolvers<null>();
  const row = address();
  const web = await mountWeb(
    <Question legacySend={(payload) => old.push(payload)} />,
    {
      authenticated: true,
      dispatch: true,
      setup(backend) {
        backend.set(query, [row]);
        backend.mutation(api.dispatch.dispatch, () => gate.promise);
      },
    },
  );
  try {
    const choose = button(web.container, "Short");
    await act(async () => {
      choose.click();
      choose.click();
      expect(
        web.store.getState().fencedPromptAddresses[row._id]?.submitted,
      ).toBe(true);
    });
    expect(
      web.container.querySelector("[data-cc-ask-settled]")?.textContent,
    ).toContain("Short");
    expect(old).toEqual([]);
    expect(web.backend.mutations).toHaveLength(1);
    expect(web.backend.mutations[0]?.args).toMatchObject({
      action: "answerFencedPrompt",
      args: [
        row._id,
        {
          conversation_id: conversationId,
          run: 1,
          lease_id: leaseId,
          turn_id: "turn",
          prompt_id: promptId,
          answer: {
            answers: { [questionId]: { answers: ["Short (Recommended)"] } },
          },
        },
      ],
    });
    await act(async () => gate.resolve(null));
  } finally {
    gate.resolve(null);
    await web.close();
  }
});

test("a permission answer rolls back on refusal and shows the reason", async () => {
  const row = address(permissionPromptId, "permission");
  const gate = Promise.withResolvers<Error>();
  const error = new ConvexError(refusal);
  error.message = `[Request ID: fake] Server Error\nUncaught ConvexError: ${refusal}`;
  const web = await mountWeb(
    <>
      <PermissionCard
        permission={{
          _id: permissionId,
          conversation_id: conversationId,
          fenced_prompt_id: permissionPromptId,
          fenced_prompt_turn_id: "turn",
          status: "pending",
          created_at: 1,
          tool_name: "item/commandExecution/requestApproval",
          arguments_preview: "pwd",
        }}
      />
      <DispatchFailureToast />
    </>,
    {
      authenticated: true,
      dispatch: true,
      expectedConsoleErrors: [
        /CONVEX M\(dispatch:dispatch\).*ConvexError/,
        /dispatch failed after retries: answerFencedPrompt/,
      ],
      setup(backend) {
        backend.set(query, [row]);
        backend.mutation(api.dispatch.dispatch, () => gate.promise);
      },
    },
  );
  try {
    await act(async () => button(web.container, "Approve").click());
    expect(web.container.textContent).toContain("Permission decision sent");
    expect(web.backend.mutations[0]?.args).toMatchObject({
      action: "answerFencedPrompt",
      args: [
        row._id,
        { prompt_id: permissionPromptId, answer: { behavior: "allow" } },
      ],
    });
    await act(async () =>
      web.backend.set(query, [{ ...row, tool_call_id: "approval-tool" }]),
    );
    expect(
      web.store.getState().fencedPromptAddresses[row._id].tool_call_id,
    ).toBe("approval-tool");
    expect(web.container.textContent).toContain("Permission decision sent");
    await act(async () => gate.resolve(error));
    expect(
      web.store.getState().fencedPromptAddresses[row._id].submitted,
    ).toBeUndefined();
    expect(button(web.container, "Approve").disabled).toBe(false);
    await expectToast(
      "error",
      `Answer fenced prompt didn't go through — ${refusal}`,
    );
  } finally {
    gate.resolve(error);
    await web.close();
  }
});

test.each([
  ["shows Question closed after a refusal if the prompt was dropped", true],
  ["reopens unchecked after a refusal if the prompt is still open", false],
] as const)("a fenced question %s", async (_name, dropped) => {
  const row = address();
  const gate = Promise.withResolvers<Error>();
  const error = new ConvexError(refusal);
  error.message = `[Request ID: fake] Server Error\nUncaught ConvexError: ${refusal}`;
  const web = await mountWeb(
    <Question
      legacySend={() => {
        throw new Error("legacy send");
      }}
    />,
    {
      authenticated: true,
      dispatch: true,
      expectedConsoleErrors: [
        /CONVEX M\(dispatch:dispatch\).*ConvexError/,
        /dispatch failed after retries: answerFencedPrompt/,
      ],
      setup(backend) {
        backend.set(query, [row]);
        backend.mutation(api.dispatch.dispatch, () => gate.promise);
      },
    },
  );
  try {
    await act(async () => button(web.container, "Short").click());
    expect(
      web.container.querySelector("[data-cc-ask-settled]")?.textContent,
    ).toContain("Short");
    if (dropped) await act(async () => web.backend.set(query, []));
    await act(async () => gate.resolve(error));
    if (dropped) {
      const text = web.container.querySelector(
        "[data-cc-ask-settled]",
      )?.textContent;
      expect(text).toContain("Question closed");
      expect(text).not.toContain("Short");
    } else {
      const option = button(web.container, "Short");
      expect(option.disabled).toBe(false);
      expect(option.querySelector("svg")).toBeNull();
      expect(
        web.store.getState().fencedPromptAddresses[row._id].answerSummary,
      ).toBeUndefined();
    }
  } finally {
    gate.resolve(error);
    await web.close();
  }
});

test("the transcript passes the conversation for a fenced question without an app-server tool id", async () => {
  const row = address();
  const tool = {
    id: promptId,
    name: "AskUserQuestion",
    input: JSON.stringify({
      fencedTurnId: "turn",
      questions: [
        { id: questionId, question: "Output?", options: [{ label: "Short" }] },
      ],
    }),
  };
  const web = await mountWeb(
    <AssistantBlock
      messageId="message"
      timestamp={1}
      toolCalls={[tool]}
      showHeader={false}
      conversationId={conversationId}
      onSendInlineMessage={() => {
        throw new Error("legacy send");
      }}
    />,
    {
      authenticated: true,
      dispatch: true,
      setup(backend) {
        backend.set(query, [row]);
        backend.mutation(api.dispatch.dispatch, null);
      },
    },
  );
  try {
    await act(async () => button(web.container, "Short").click());
    expect(web.backend.mutations).toHaveLength(1);
    expect(web.backend.mutations[0]?.args).toMatchObject({
      action: "answerFencedPrompt",
      args: [row._id, { prompt_id: promptId, turn_id: "turn" }],
    });
  } finally {
    await web.close();
  }
});

test("decision surfaces cannot send a legacy choice or free-text answer to a fenced question", async () => {
  function Probe() {
    const decision = useDecisionAnswer({
      key: "ask",
      source: "ask",
      conversationId,
      question: "",
      options: [],
      blocking: true,
      createdAt: 1,
    });
    return (
      <>
        <output data-option-count={decision.options.length}>
          {decision.question}
        </output>
        <button onClick={() => void decision.answer(0)}>Choose</button>
        <button onClick={() => decision.answerFreeText("Custom text")}>
          Type answer
        </button>
      </>
    );
  }
  const web = await mountWeb(<Probe />, {
    authenticated: true,
    dispatch: true,
    setup(backend, store) {
      store.setMessages(conversationId, [
        {
          _id: "assistant",
          role: "assistant",
          timestamp: 1,
          tool_calls: [
            {
              id: promptId,
              name: "AskUserQuestion",
              input: JSON.stringify({
                fencedTurnId: "turn",
                questions: [
                  { question: "Output?", options: [{ label: "Short" }] },
                ],
              }),
            },
          ],
        },
      ]);
      backend.mutation(api.dispatch.dispatch, null);
    },
  });
  try {
    const output = web.container.querySelector("output");
    expect(output?.textContent).toBe("Output?");
    await act(async () => {
      button(web.container, "Choose").click();
      button(web.container, "Type answer").click();
    });
    expect(web.backend.mutations).toEqual([]);
    expect(output?.dataset.optionCount).toBe("0");
  } finally {
    await web.close();
  }
});

test("a late click cannot answer a replacement prompt in another turn", async () => {
  const old: string[] = [];
  const web = await mountWeb(
    <Question legacySend={(payload) => old.push(payload)} />,
    {
      authenticated: true,
      dispatch: true,
      setup(backend) {
        backend.set(query, [address()]);
        backend.mutation(api.dispatch.dispatch, null);
      },
    },
  );
  try {
    const oldButton = button(web.container, "Short");
    await act(async () => {
      web.backend.set(query, [address(promptId, "question", "next-turn")]);
    });
    await act(async () => oldButton.click());
    expect(web.container.textContent).toContain("Question closed");
    expect(web.backend.mutations).toEqual([]);
    expect(old).toEqual([]);
  } finally {
    await web.close();
  }
});

test("an old question keeps the message path and a secret question offers no input", async () => {
  const old: string[] = [];
  const legacySend = (payload: string) => old.push(payload);
  const web = await mountWeb(<Question old legacySend={legacySend} />, {
    authenticated: true,
    setup(backend) {
      backend.set(query, [address()]);
    },
  });
  try {
    expect(web.backend.queryRequests).toEqual([]);
    await act(async () => button(web.container, "Short").click());
    expect(old.map((payload) => JSON.parse(payload))).toEqual([
      { __cc_poll: true, keys: ["1"], display: "Short" },
    ]);
    await web.rerender(
      <Question key="secret" secret legacySend={legacySend} />,
    );
    expect(web.container.querySelector("input")).toBeNull();
    expect(web.container.textContent).toContain("Secret question cancelled");
    expect(web.backend.mutations).toEqual([]);
  } finally {
    await web.close();
  }
});

test("typed text uses the provider question id through the same dispatch", async () => {
  const row = address();
  const web = await mountWeb(
    <Question
      legacySend={() => {
        throw new Error("legacy send");
      }}
    />,
    {
      authenticated: true,
      dispatch: true,
      setup(backend) {
        backend.set(query, [row]);
        backend.mutation(api.dispatch.dispatch, null);
      },
    },
  );
  try {
    const input = web.container.querySelector("input")!;
    const setValue = Object.getOwnPropertyDescriptor(
      web.dom.window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      setValue.call(input, "Custom output");
      input.dispatchEvent(new web.dom.window.Event("input", { bubbles: true }));
    });
    expect(button(web.container, "Send").disabled).toBe(false);
    await act(async () => button(web.container, "Send").click());
    expect(web.backend.mutations[0]?.args).toMatchObject({
      action: "answerFencedPrompt",
      args: [
        row._id,
        {
          prompt_id: promptId,
          answer: { answers: { [questionId]: { answers: ["Custom output"] } } },
        },
      ],
    });
  } finally {
    await web.close();
  }
});

test("an old permission without a prompt id uses the legacy permission action", async () => {
  const permission = {
    _id: permissionId,
    conversation_id: conversationId,
    status: "pending" as const,
    created_at: 1,
    tool_name: "Read",
    arguments_preview: "notes.txt",
  };
  const web = await mountWeb(<PermissionCard permission={permission} />, {
    authenticated: true,
    dispatch: true,
    setup(backend, store) {
      store.syncTable("pendingPermissions", [permission]);
      backend.mutation(api.dispatch.dispatch, null);
    },
  });
  try {
    await act(async () => button(web.container, "Approve").click());
    expect(web.backend.queryRequests).toEqual([]);
    expect(web.backend.mutations[0]?.args).toMatchObject({
      action: "resolvePermission",
      args: [permissionId, "approved", null],
    });
    expect(
      web.store.getState().pendingPermissions[permissionId],
    ).toBeUndefined();
  } finally {
    await web.close();
  }
});

test("a secret marker from the address feed removes the input on the mounted card", async () => {
  const row = address();
  const web = await mountWeb(
    <Question
      legacySend={() => {
        throw new Error("legacy send");
      }}
    />,
    {
      authenticated: true,
      setup(backend) {
        backend.set(query, [row]);
      },
    },
  );
  try {
    expect(web.container.querySelector("input")).not.toBeNull();
    await act(async () => {
      web.backend.set(query, [
        {
          ...row,
          questions: [{ id: questionId, is_secret: true }],
        },
      ]);
    });
    expect(web.container.querySelector("input")).toBeNull();
    expect(web.container.textContent).toContain("Secret question cancelled");
  } finally {
    await web.close();
  }
});
