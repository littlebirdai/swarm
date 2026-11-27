import type { api } from "@codecast/convex/convex/_generated/api";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { cascadeFromAnswer } from "@codecast/policy/permissionRules";
import type { InboxStoreState } from "./inboxStore";
import { action, sync } from "./mutativeMiddleware";

type AnswerArgs = FunctionArgs<typeof api.permissions.answerPrompt>;

export type FencedPromptAddress = FunctionReturnType<
  typeof api.permissions.listAnswerablePromptAddresses
>[number] & {
  submitted?: true;
  accepted?: true;
  feedAbsent?: true;
  answerSummary?: Record<string, string>;
};

export function canUsePromptAddress(address: FencedPromptAddress | undefined) {
  return !!address && address.answerer?.can_answer !== false;
}

export function promptAnswererLabel(answerer: FencedPromptAddress["answerer"]) {
  return answerer
    ? `Answers · ${answerer.can_answer ? "You" : answerer.name}`
    : undefined;
}

export interface FencedPromptAnswerActions {
  answerFencedPrompt: (rowId: string, args: AnswerArgs) => void;
  acceptFencedPromptAnswer: (rowId: string) => void;
  refuseFencedPromptAnswer: (rowId: string) => void;
  reconcileFencedPromptAddresses: (
    conversationId: string,
    ids: ReadonlySet<string>,
  ) => void;
}

type PromptDraft = Pick<InboxStoreState, "pending" | "pendingPermissions"> & {
  fencedPromptAddresses: Record<string, FencedPromptAddress>;
};

function clearAddressLocks(draft: PromptDraft, rowId: string) {
  delete draft.pending[`fencedPromptAddresses:${rowId}:submitted`];
  delete draft.pending[`fencedPromptAddresses:${rowId}:answerSummary`];
}

function retireAddress(draft: PromptDraft, row: FencedPromptAddress) {
  clearAddressLocks(draft, row._id);
  if (row.accepted && row.kind === "question") return;
  if (
    row.accepted &&
    Object.values(draft.pendingPermissions).some(
      (permission) =>
        permission.status === "pending" &&
        permission.conversation_id === row.conversation_id &&
        permission.fenced_prompt_id === row.prompt_id &&
        permission.fenced_prompt_turn_id === row.turn_id,
    )
  )
    return;
  delete draft.fencedPromptAddresses[row._id];
}

export function pruneSettledFencedPermissionAddresses(draft: PromptDraft) {
  for (const row of Object.values(draft.fencedPromptAddresses))
    if (row.kind === "permission" && row.accepted && row.feedAbsent)
      retireAddress(draft, row);
}

type PermissionDraft = Pick<
  InboxStoreState,
  "pendingPermissions" | "questionResolutions" | "sessions"
>;

export const promptAnswerActions: FencedPromptAnswerActions &
  Pick<InboxStoreState, "resolvePermission"> = {
  answerFencedPrompt: action(function (
    this: { fencedPromptAddresses: Record<string, FencedPromptAddress> },
    rowId: string,
    { answer }: AnswerArgs,
  ) {
    const row = this.fencedPromptAddresses[rowId];
    if (!row || row.feedAbsent) return;
    row.submitted = true;
    if (answer !== null && typeof answer === "object" && "answers" in answer)
      row.answerSummary = Object.fromEntries(
        Object.entries(answer.answers).map(([id, response]) => [
          id,
          response.answers.join(", "),
        ]),
      );
  }),
  acceptFencedPromptAnswer: sync(function (this: PromptDraft, rowId: string) {
    const row = this.fencedPromptAddresses[rowId];
    clearAddressLocks(this, rowId);
    if (!row?.submitted || row.accepted) return;
    row.accepted = true;
    delete row.submitted;
    if (row.feedAbsent) retireAddress(this, row);
  }),
  refuseFencedPromptAnswer: sync(function (this: PromptDraft, rowId: string) {
    const row = this.fencedPromptAddresses[rowId];
    if (!row || row.accepted) return;
    delete row.answerSummary;
    if (row.feedAbsent) retireAddress(this, row);
  }),
  reconcileFencedPromptAddresses: sync(function (
    this: PromptDraft,
    conversationId: string,
    ids: ReadonlySet<string>,
  ) {
    for (const row of Object.values(this.fencedPromptAddresses)) {
      if (row.conversation_id !== conversationId) continue;
      if (ids.has(row._id)) {
        if (!row.accepted) delete row.feedAbsent;
      } else if (row.submitted || row.accepted) {
        row.feedAbsent = true;
        if (row.accepted) retireAddress(this, row);
      } else {
        retireAddress(this, row);
      }
    }
  }),
  resolvePermission: action(function (
    this: PermissionDraft,
    permissionId: string,
    status: "approved" | "denied",
    opts?: { message?: string; remember?: boolean },
  ) {
    const row = this.pendingPermissions[permissionId] as any;
    if (!row) return;
    const pending = Object.values(this.pendingPermissions).filter(
      (p: any) => p?.status === "pending" && p.fenced_prompt_id === undefined,
    ) as any[];
    const cascade = cascadeFromAnswer(row, { status, ...opts }, pending, []);
    delete this.pendingPermissions[permissionId];
    for (const id of [...cascade.approve, ...cascade.deny])
      delete this.pendingPermissions[id];
    const convId = row.conversation_id as string | undefined;
    if (!convId) return;
    const stillPending = Object.values(this.pendingPermissions).some(
      (p: any) => p?.conversation_id === convId && p.status === "pending",
    );
    if (!stillPending) {
      this.questionResolutions[convId] = {
        at: Date.now(),
        message_count: this.sessions[convId]?.message_count ?? 0,
      };
    }
  }),
};

export function findFencedPromptAddress(
  rows: readonly FencedPromptAddress[],
  promptId: string,
  turnId: string | undefined,
  kind: FencedPromptAddress["kind"],
) {
  const matches = rows.filter(
    (row) =>
      row.kind === kind &&
      row.prompt_id === promptId &&
      (turnId === undefined || row.turn_id === turnId),
  );
  const live = matches.filter((row) => !row.feedAbsent);
  return live.length === 1
    ? live[0]
    : live.length === 0 && matches.length === 1
      ? matches[0]
      : undefined;
}

export function submitFencedPromptAnswer(
  store: FencedPromptAnswerActions & {
    fencedPromptAddresses: Record<string, FencedPromptAddress>;
  },
  address: FencedPromptAddress,
  answer: AnswerArgs["answer"],
): boolean {
  const { _id, conversation_id, run, lease_id, turn_id, prompt_id } = address;
  const current = store.fencedPromptAddresses[_id];
  if (
    !current ||
    current.submitted ||
    current.accepted ||
    current.feedAbsent ||
    current.answerer?.can_answer === false
  )
    return false;
  store.answerFencedPrompt(_id, {
    conversation_id,
    run,
    lease_id,
    turn_id,
    prompt_id,
    answer,
  });
  return true;
}
