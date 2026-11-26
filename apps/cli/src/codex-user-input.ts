import { pollMenuSteps, type PollMessage } from "./pollMessage.js";

export type CodexQuestion = {
  id: string;
  question: string;
  header?: string;
  isSecret?: boolean;
  options: Array<{ label: string; description?: string }>;
};

export type CodexUserInputResponse = {
  answers: Record<string, { answers: string[] }>;
};

export function readCodexQuestions(value: unknown): CodexQuestion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((question: unknown) => {
    if (!question || typeof question !== "object") return [];
    const {
      id,
      question: text,
      header,
      isSecret,
      options,
    } = question as Record<string, unknown>;
    if (typeof id !== "string" || typeof text !== "string") return [];
    return [
      {
        id,
        question: text,
        header: typeof header === "string" ? header : undefined,
        isSecret: isSecret === true,
        options: Array.isArray(options)
          ? options.filter(
              (option): option is CodexQuestion["options"][number] =>
                typeof option?.label === "string" &&
                (option.description === undefined ||
                  typeof option.description === "string"),
            )
          : [],
      },
    ];
  });
}

export function codexUserInputResponse(
  questions: CodexQuestion[],
  poll: PollMessage | null,
): CodexUserInputResponse {
  if (!poll) return { answers: {} };
  const keys = pollMenuSteps(poll).map(({ key }) => key);
  if (keys.includes("Escape")) return { answers: {} };
  const embedded = poll.steps?.flatMap(({ text }) =>
    text === undefined ? [] : [text],
  );
  const typed =
    poll.text ?? (embedded?.length ? embedded.join("\n\n") : undefined);
  const values = new Map<string, string>();
  if (typed !== undefined) {
    if (questions.length === 1) {
      if (typed.trim()) values.set(questions[0].id, typed.trim());
    } else {
      const headers = questions.map(
        (q, index) =>
          `${q.header?.trim() || q.question.replace(/\s+/g, " ").trim().slice(0, 60) || `Q${index + 1}`}: `,
      );
      let current: string | undefined;
      for (const segment of typed.trim().split(/\n\n/)) {
        const index = headers.findIndex((header) => segment.startsWith(header));
        if (index >= 0) {
          current = questions[index].id;
          values.set(current, segment.slice(headers[index].length));
        } else if (current) {
          values.set(current, `${values.get(current)}\n\n${segment}`);
        }
      }
    }
  } else {
    const picks = keys.filter((key) => /^\d+$/.test(key));
    for (const [index, question] of questions.entries()) {
      const label = question.options[Number(picks[index]) - 1]?.label;
      if (label) values.set(question.id, label);
    }
  }
  return {
    answers: Object.fromEntries(
      [...values]
        .filter(([, value]) => value.trim())
        .map(([id, value]) => [id, { answers: [value] }]),
    ),
  };
}

export function approvalResultForMethod(
  method: string,
  approved: boolean,
  params?: Record<string, unknown>,
): Record<string, unknown> {
  switch (method) {
    case "execCommandApproval":
    case "applyPatchApproval":
      return { decision: approved ? "approved" : "denied" };

    case "item/commandExecution/requestApproval":
      return { decision: approved ? "accept" : "decline" };

    case "item/fileChange/requestApproval":
      return { decision: approved ? "accept" : "decline" };

    case "item/permissions/requestApproval": {
      const requested = (params?.permissions || {}) as Record<string, unknown>;
      return approved
        ? { permissions: requested, scope: "session" }
        : { permissions: {}, scope: "turn" };
    }

    case "item/tool/requestUserInput":
      return { answers: {} };

    case "item/tool/call":
      return { contentItems: [], success: approved };

    default:
      return { decision: approved ? "approved" : "denied" };
  }
}
