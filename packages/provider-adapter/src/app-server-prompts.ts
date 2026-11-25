import type { EdgeJson } from "@codecast/edge-contract";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { diagnostic, type DurablePayload } from "./provider-events";
import { QuestionAnswers, type Prompt } from "./app-server-schema";

export function describePrompt(
  wire: typeof Prompt.Type,
  key: string,
): DurablePayload[] {
  const question = wire.method === "item/tool/requestUserInput";
  const { itemId } = wire.params;
  const summary = diagnostic(
    question
      ? wire.params.questions.map(({ question }) => question).join(" ")
      : (wire.params.reason ??
          (wire.method === "item/commandExecution/requestApproval"
            ? wire.params.command
            : undefined)),
  );
  const events: DurablePayload[] = [
    {
      kind: "prompt.opened",
      body: {
        prompt_id: key,
        kind: question ? "question" : "permission",
        ...(itemId.trim() && itemId.length <= 256
          ? { tool_call_id: itemId }
          : {}),
        ...(summary ? { summary } : {}),
      },
    },
  ];
  if (question)
    events.push({
      kind: "context",
      body: {
        data: {
          prompt_id: key,
          questions: wire.params.questions.map((entry) => ({
            id: entry.id,
            question: diagnostic(entry.question),
            ...(entry.header ? { header: diagnostic(entry.header) } : {}),
            is_other: entry.isOther ?? false,
            is_secret: entry.isSecret ?? false,
            ...(entry.options
              ? {
                  options: entry.options.map(({ label, description }) => ({
                    label: diagnostic(label),
                    description: diagnostic(description),
                  })),
                }
              : {}),
          })),
        },
      },
    });
  return events;
}

export const prepareAnswer = Effect.fn("app-server.prepare-answer")(function* (
  wire: typeof Prompt.Type,
  body: EdgeJson,
): Effect.fn.Return<{ result: object; publicAnswer: EdgeJson } | undefined> {
  if (wire.method === "item/tool/requestUserInput") {
    if (body === null) return { result: { answers: {} }, publicAnswer: null };
    const parsed = yield* Effect.result(
      Schema.decodeUnknownEffect(QuestionAnswers)(body, {
        onExcessProperty: "error",
      }),
    );
    if (parsed._tag === "Failure") return;
    const questions = new Map(
      wire.params.questions.map((question) => [question.id, question]),
    );
    const entries = Object.entries(parsed.success.answers);
    if (!entries.every(([id]) => questions.has(id))) return;
    return {
      result: parsed.success,
      publicAnswer: {
        answers: Object.fromEntries(
          entries.map(([id, { answers }]) => [
            id,
            {
              answers: questions.get(id)?.isSecret
                ? answers.map(() => "[redacted]")
                : [...answers],
            },
          ]),
        ),
      },
    };
  }
  const behavior =
    body === null
      ? "deny"
      : typeof body === "object" && !Array.isArray(body)
        ? body.behavior
        : undefined;
  if (behavior !== "allow" && behavior !== "deny") return;
  if (wire.method === "item/permissions/requestApproval")
    return {
      result: {
        permissions: behavior === "allow" ? wire.params.permissions : {},
        scope: "turn",
      },
      publicAnswer: body,
    };
  const offered =
    wire.method === "item/commandExecution/requestApproval"
      ? wire.params.availableDecisions
      : undefined;
  const decision =
    behavior === "allow"
      ? "accept"
      : body === null &&
          offered?.includes("cancel") &&
          !offered.includes("decline")
        ? "cancel"
        : "decline";
  if (offered && !offered.includes(decision)) return;
  return { result: { decision }, publicAnswer: body };
});
