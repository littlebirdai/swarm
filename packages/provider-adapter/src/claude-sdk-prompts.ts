import type { EdgeJson, PromptOpened } from "@codecast/edge-contract";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Questions, type Prompt } from "./claude-sdk-schema";
import { diagnostic, type DurablePayload } from "./provider-events";

const answers = Schema.Struct({
  answers: Schema.Record(
    Schema.String,
    Schema.Struct({
      answers: Schema.Array(Schema.String).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(16),
      ),
    }),
  ),
});

export const describePrompt = Effect.fn("claude-sdk.describe-prompt")(
  function* ({ request }: typeof Prompt.Type, promptId: string) {
    const question = request.tool_name === "AskUserQuestion";
    const decoded = question
      ? yield* Effect.result(
          Schema.decodeUnknownEffect(Questions)(request.input),
        )
      : undefined;
    if (decoded?._tag === "Failure") return;
    const questions = decoded?.success.questions;
    if (
      questions &&
      new Set(questions.map((entry) => entry.question)).size !==
        questions.length
    )
      return;
    const first = questions?.[0];
    let offered: NonNullable<PromptOpened["options"]> = [];
    if (!questions) {
      offered = [
        { id: "allow", label: "Allow", kind: "allow_once" },
        { id: "deny", label: "Deny", kind: "reject_once" },
      ];
    } else if (questions.length === 1 && first && !first.multiSelect) {
      offered = first.options.slice(0, 16).map(({ label }, index) => ({
        id: String(index),
        label: diagnostic(label).slice(0, 128) || `Option ${index + 1}`,
      }));
    }
    const summary = diagnostic(
      questions?.map((entry) => entry.question).join(" ") ??
        request.description ??
        request.tool_name,
    );
    const events: DurablePayload[] = [
      {
        kind: "prompt.opened",
        body: {
          prompt_id: promptId,
          kind: question ? "question" : "permission",
          ...(summary ? { summary } : {}),
          ...(offered.length ? { options: offered } : {}),
          tool_call_id: request.tool_use_id,
          tool_name: diagnostic(request.tool_name).slice(0, 128) || "Tool",
        },
      },
    ];
    if (questions)
      events.push({
        kind: "context",
        body: {
          data: {
            prompt_id: promptId,
            questions: questions.map((entry, index) => ({
              id: String(index),
              question: diagnostic(entry.question),
              header: diagnostic(entry.header),
              multi_select: entry.multiSelect ?? false,
              options: entry.options
                .slice(0, 16)
                .map(({ label, description }, option) => ({
                  id: String(option),
                  label: diagnostic(label),
                  description: diagnostic(description),
                })),
            })),
          },
        },
      });
    return { events, questions, offered };
  },
);

export type PromptDetails = NonNullable<
  Effect.Success<ReturnType<typeof describePrompt>>
>;

export function reply(requestId: string, response: object) {
  return {
    type: "control_response",
    response: { subtype: "success", request_id: requestId, response },
  };
}

export const prepareAnswer = Effect.fn("claude-sdk.prepare-answer")(function* (
  wire: typeof Prompt.Type,
  details: PromptDetails,
  body: EdgeJson,
): Effect.fn.Return<{ response: object; publicAnswer: EdgeJson } | undefined> {
  const { input, tool_use_id: toolUseID } = wire.request;
  const entry =
    body && typeof body === "object" && !Array.isArray(body) ? body : undefined;
  const choice =
    entry && Object.keys(entry).length === 1
      ? details.offered.find(({ id }) => id === entry.option_id)
      : undefined;
  if (
    body === null ||
    choice?.id === "deny" ||
    (!details.questions && entry?.behavior === "deny")
  )
    return {
      response: {
        behavior: "deny",
        message: "The user denied the request.",
        toolUseID,
      },
      publicAnswer: choice
        ? { option_id: choice.id }
        : body === null
          ? null
          : { behavior: "deny" },
    };
  if (!details.questions)
    return choice?.id === "allow" || entry?.behavior === "allow"
      ? {
          response: { behavior: "allow", updatedInput: input, toolUseID },
          publicAnswer: choice
            ? { option_id: choice.id }
            : { behavior: "allow" },
        }
      : undefined;
  if (choice) {
    const question = details.questions[0]!;
    const label = question.options[Number(choice.id)]!.label;
    return {
      response: {
        behavior: "allow",
        updatedInput: { ...input, answers: { [question.question]: label } },
        toolUseID,
      },
      publicAnswer: { option_id: choice.id },
    };
  }
  const parsed = yield* Effect.result(
    Schema.decodeUnknownEffect(answers)(body, { onExcessProperty: "error" }),
  );
  if (parsed._tag === "Failure") return;
  const entries = Object.entries(parsed.success.answers);
  if (entries.length !== details.questions.length) return;
  const selected: [string, string][] = [];
  for (const [index, question] of details.questions.entries()) {
    const values = parsed.success.answers[String(index)]?.answers;
    if (
      !values ||
      (!question.multiSelect && values.length !== 1) ||
      values.some((value) => !value.trim())
    )
      return;
    selected.push([question.question, values.join(", ")]);
  }
  return {
    response: {
      behavior: "allow",
      updatedInput: { ...input, answers: Object.fromEntries(selected) },
      toolUseID,
    },
    publicAnswer: {
      answers: Object.fromEntries(
        entries.map(([key, value]) => [
          key,
          { answers: value.answers.map((answer) => diagnostic(answer)) },
        ]),
      ),
    },
  };
});
