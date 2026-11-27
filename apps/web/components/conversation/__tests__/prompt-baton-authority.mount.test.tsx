import { expect, test } from "bun:test";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { act } from "react";
import { mountWeb } from "../../../test-helpers/mountWeb";
import type { FencedPromptAddress } from "../../../store/fenced-prompt-answer";
import { ThemeContext } from "../../ThemeProvider";
import { PermissionCard } from "../../permission-card";
import { ModernAskUserQuestion } from "../blocks/modern-ask-user-question";

const conversationId = "a".repeat(32) as Id<"conversations">;
const leaseId = "b".repeat(32) as Id<"run_leases">;
const permissionId = "c".repeat(32) as Id<"pending_permissions">;
const questionId = "choice";
const permissionPromptId = "approval";
const query = api.permissions.getFencedPromptFeed;
const promptFeed = (prompts: FencedPromptAddress[]) => ({
  prompts,
  turn: null,
});

function address(
  prompt_id = "question",
  kind: FencedPromptAddress["kind"] = "question",
): FencedPromptAddress {
  return {
    _id: JSON.stringify([leaseId, "turn", prompt_id]),
    conversation_id: conversationId,
    lease_id: leaseId,
    run: 1,
    turn_id: "turn",
    prompt_id,
    kind,
    questions:
      kind === "question" ? [{ id: questionId, is_secret: false }] : [],
  };
}

function Question() {
  return (
    <ModernAskUserQuestion
      conversationId={conversationId}
      tool={{ id: "question", name: "AskUserQuestion", input: "{}" }}
      parsedInput={{
        fencedTurnId: "turn",
        questions: [
          {
            id: questionId,
            question: "Choose the output",
            options: [{ label: "Short" }],
          },
        ],
      }}
    />
  );
}

function button(container: HTMLElement, label: string) {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Button ${label} is missing`);
  return found;
}

test("a routine card names its answerer and can close for a non-answering viewer", async () => {
  const flag = "VITE_SWARM_TURN_BATON";
  const previous = process.env[flag];
  process.env[flag] = "1";
  try {
    const row = address();
    const web = await mountWeb(<Question />, {
      authenticated: true,
      dispatch: true,
      setup(backend) {
        backend.set(
          query,
          promptFeed([
            { ...row, answerer: { name: "Baton holder", can_answer: false } },
          ]),
        );
        backend.mutation(api.dispatch.dispatch, null);
      },
    });
    expect(web.container.textContent).toContain("Answers · Baton holder");
    expect(button(web.container, "Short").disabled).toBe(true);
    await act(async () => button(web.container, "Short").click());
    expect(web.backend.mutations).toHaveLength(0);
    await act(async () => web.backend.set(query, promptFeed([])));
    expect(web.container.textContent).toContain("Question closed");
    expect(web.container.querySelector("[data-cc-ask-settled]")).toBeTruthy();
  } finally {
    if (previous === undefined) delete process.env[flag];
    else process.env[flag] = previous;
  }
});

test("a baton holder submits a routine question through its exact address without a send callback", async () => {
  const flag = "VITE_SWARM_TURN_BATON";
  const previous = process.env[flag];
  process.env[flag] = "1";
  try {
    const row = address();
    const web = await mountWeb(<Question />, {
      authenticated: true,
      dispatch: true,
      setup(backend) {
        backend.set(
          query,
          promptFeed([
            { ...row, answerer: { name: "Baton holder", can_answer: true } },
          ]),
        );
        backend.mutation(api.dispatch.dispatch, null);
      },
    });
    expect(web.container.textContent).toContain("Answers · You");
    await act(async () => button(web.container, "Short").click());
    expect(web.backend.mutations).toHaveLength(1);
    expect(web.backend.mutations[0]?.args).toMatchObject({
      action: "answerFencedPrompt",
      args: [
        row._id,
        {
          run: row.run,
          turn_id: row.turn_id,
          lease_id: row.lease_id,
          prompt_id: row.prompt_id,
        },
      ],
    });
  } finally {
    if (previous === undefined) delete process.env[flag];
    else process.env[flag] = previous;
  }
});

test.each(["classic", "modern"] as const)(
  "a read-only %s escalation card has no busy marker or shortcut hints",
  async (visualStyle) => {
    const row = address(permissionPromptId, "permission");
    const web = await mountWeb(
      <ThemeContext.Provider
        value={{
          theme: "light",
          toggleTheme: () => {},
          visualStyle,
          setVisualStyle: () => {},
        }}
      >
        <PermissionCard
          permission={{
            _id: permissionId,
            conversation_id: conversationId,
            fenced_prompt_id: permissionPromptId,
            fenced_prompt_turn_id: row.turn_id,
            tool_name: "Deploy",
            status: "pending",
            created_at: 1,
          }}
        />
      </ThemeContext.Provider>,
      {
        authenticated: true,
        dispatch: true,
        setup(backend) {
          backend.set(
            query,
            promptFeed([
              {
                ...row,
                answerer: { name: "Session owner", can_answer: false },
              },
            ]),
          );
          backend.mutation(api.dispatch.dispatch, null);
        },
      },
    );
    expect(web.container.textContent).toContain("Answers · Session owner");
    expect(web.container.textContent).not.toContain("...");
    expect(button(web.container, "Approve").disabled).toBe(true);
    expect(button(web.container, "Deny").disabled).toBe(true);
    expect(web.container.querySelectorAll("kbd")).toHaveLength(0);
    await act(async () => {
      for (const key of ["y", "n"]) {
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key, bubbles: true }),
        );
      }
    });
    expect(web.backend.mutations).toHaveLength(0);
    await act(async () =>
      web.backend.set(
        query,
        promptFeed([
          { ...row, answerer: { name: "Session owner", can_answer: true } },
        ]),
      ),
    );
    expect(web.container.textContent).toContain("Answers · You");
    expect(web.container.querySelectorAll("kbd")).toHaveLength(2);
    await act(async () => button(web.container, "Approve").click());
    expect(web.backend.mutations).toHaveLength(1);
    expect(web.backend.mutations[0]?.args).toMatchObject({
      action: "answerFencedPrompt",
      args: [row._id, { prompt_id: permissionPromptId }],
    });
  },
);
