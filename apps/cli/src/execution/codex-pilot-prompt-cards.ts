import type { ClaimGrant } from "@codecast/edge-client";
import type { CanonicalEvent, EdgeJson } from "@codecast/edge-contract";
import type { RawProviderFrame } from "@codecast/provider-adapter";
import type { OwnedSession } from "@codecast/provider-contract";
import { redactSecrets } from "../redact.js";
import type { SyncService } from "../syncService.js";

type Question = {
  id: string;
  question: string;
  header?: string;
  isSecret: boolean;
  options: { label: string; description?: string }[];
};

type PermissionCard = { kind: "permission"; turn: string; rowId: string };
type QuestionCard = {
  kind: "question";
  turn: string;
  messageUuid: string;
  questions?: Question[];
};
type OpenCard = PermissionCard | QuestionCard;
type Settled = Extract<CanonicalEvent, { kind: "prompt.settled" }>;

function object(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
}

function readQuestions(value: unknown): Question[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return;
  const questions: Question[] = [];
  const ids = new Set<string>();
  for (const valueQuestion of value) {
    const entry = object(valueQuestion);
    if (
      !entry ||
      typeof entry.id !== "string" ||
      !entry.id.trim() ||
      ids.has(entry.id) ||
      typeof entry.question !== "string" ||
      typeof entry.is_secret !== "boolean"
    )
      return;
    ids.add(entry.id);
    const options = Array.isArray(entry.options) ? entry.options : [];
    questions.push({
      id: entry.id,
      question: entry.question,
      ...(typeof entry.header === "string" && { header: entry.header }),
      isSecret: entry.is_secret,
      options: options.flatMap((valueOption: unknown) => {
        const option = object(valueOption);
        return typeof option?.label === "string"
          ? [
              {
                label: option.label,
                ...(typeof option.description === "string" && {
                  description: option.description,
                }),
              },
            ]
          : [];
      }),
    });
  }
  return questions;
}

function resolution(questions: readonly Question[], answer: EdgeJson): string {
  const answers = object(object(answer)?.answers);
  if (!answers) return "Codex question cancelled";
  const chosen = questions.flatMap(({ id, question }) => {
    const values = object(answers[id])?.answers;
    if (
      !Array.isArray(values) ||
      !values.every((value) => typeof value === "string")
    )
      return [];
    return [{ question, value: values.join(", ") }];
  });
  if (!chosen.length) return "Codex question cancelled";
  if (questions.length === 1)
    return `Answered from the app: ${chosen[0]!.value}`;
  return chosen
    .map(({ question, value }) => `"${question}"="${value}"`)
    .join(", ");
}

export class CodexPilotPromptCards {
  private readonly open = new Map<string, OpenCard>();
  private readonly approval = new Map<
    string,
    { method: string; preview: string }
  >();

  retain(frame: RawProviderFrame): void {
    if (frame.disposition !== "decoded" || frame.base64Fragment) return;
    const message = object(JSON.parse(frame.line));
    if (
      typeof message?.method !== "string" ||
      !message.method.endsWith("/requestApproval")
    )
      return;
    const args = object(message.params);
    if (typeof args?.turnId !== "string" || typeof args.itemId !== "string")
      return;
    const key = JSON.stringify([args.turnId, args.itemId]);
    if (this.approval.size >= 128 && !this.approval.has(key)) {
      const first = this.approval.keys().next().value;
      if (first !== undefined) this.approval.delete(first);
    }
    this.approval.set(key, {
      method: message.method,
      preview: redactSecrets(JSON.stringify(args)).slice(0, 200),
    });
  }

  async publish(
    event: CanonicalEvent,
    claim: ClaimGrant,
    session: OwnedSession,
    syncService: SyncService,
    onBlocked: () => void,
  ): Promise<void> {
    const { session: conversationId, turn, at } = event;
    if (event.kind === "prompt.opened" && turn) {
      const { prompt_id, tool_call_id, kind, summary } = event.body;
      if (this.open.has(prompt_id)) return;
      if (kind === "question") {
        this.open.set(prompt_id, {
          kind,
          turn,
          messageUuid: `owned-prompt:${event.run}:${turn}:${prompt_id}`,
        });
      } else if (kind === "permission") {
        const key = JSON.stringify([turn, tool_call_id]);
        const raw = this.approval.get(key);
        this.approval.delete(key);
        const rowId = await syncService.createPermissionRequest({
          conversation_id: conversationId,
          session_id: session.getCheckpoint(),
          fenced_prompt_id: prompt_id,
          fenced_prompt_turn_id: turn,
          tool_name: raw?.method ?? event.body.tool_name ?? "Codex permission",
          arguments_preview: raw?.preview ?? summary ?? "",
        });
        this.open.set(prompt_id, { kind, turn, rowId });
        onBlocked();
      }
      return;
    }

    if (event.kind === "context") {
      const data = object(event.body.data);
      if (typeof data?.prompt_id !== "string") return;
      const card = this.open.get(data.prompt_id);
      if (card?.kind !== "question" || card.turn !== turn || card.questions)
        return;
      const questions = readQuestions(data.questions);
      if (!questions || questions.some(({ isSecret }) => isSecret)) {
        await session.answer({
          expected: {
            run: claim.run,
            fencing_token: claim.fencing_token,
            prompt_id: data.prompt_id,
          },
          by: { kind: "agent", id: "codex" },
          answer: null,
        });
        return;
      }
      await syncService.addMessages({
        conversationId,
        messages: [
          {
            messageUuid: card.messageUuid,
            role: "assistant",
            content: "",
            timestamp: at,
            toolCalls: [
              {
                id: data.prompt_id,
                name: "AskUserQuestion",
                input: { questions, fencedTurnId: turn },
              },
            ],
          },
        ],
      });
      card.questions = questions;
      onBlocked();
      return;
    }

    if (event.kind === "prompt.settled") {
      await this.close(
        event.body.prompt_id,
        event,
        syncService,
        event.body.answer,
      );
    } else if (event.kind === "turn.ended" || event.kind === "session.ended") {
      for (const [id, card] of this.open)
        if (event.kind === "session.ended" || card.turn === turn)
          await this.close(id, event, syncService, null);
    }
  }

  private async close(
    id: string,
    event:
      | Settled
      | Extract<CanonicalEvent, { kind: "turn.ended" | "session.ended" }>,
    syncService: SyncService,
    answer: EdgeJson,
  ): Promise<void> {
    const card = this.open.get(id);
    if (!card) return;
    if (card.kind === "permission") {
      await syncService.cancelPermissionRequest(card.rowId);
    } else if (card.questions) {
      await syncService.addMessages({
        conversationId: event.session,
        messages: [
          {
            messageUuid: `${card.messageUuid}-closed`,
            role: "human",
            content: "",
            timestamp: event.at,
            toolResults: [
              { toolUseId: id, content: resolution(card.questions, answer) },
            ],
          },
        ],
      });
    }
    this.open.delete(id);
  }
}
