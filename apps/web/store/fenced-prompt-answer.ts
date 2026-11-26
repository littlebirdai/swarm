import type { api } from "@codecast/convex/convex/_generated/api";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { cascadeFromAnswer } from "@codecast/policy/permissionRules";
import type { InboxStoreState } from "./inboxStore";
import { action } from "./mutativeMiddleware";

type AnswerArgs = FunctionArgs<typeof api.permissions.answerPrompt>;

export type FencedPromptAddress = FunctionReturnType<
  typeof api.permissions.listAnswerablePromptAddresses
>[number] & { submitted?: true };

export interface FencedPromptAnswerActions {
  answerFencedPrompt: (rowId: string, args: AnswerArgs) => void;
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
    _args: AnswerArgs,
  ) {
    const row = this.fencedPromptAddresses[rowId];
    if (row) row.submitted = true;
  }),
  // `pendingPermissions` is localFirst, so removing the row plants an exclude
  // that holds over pushes racing the write and is released if the server
  // refuses it. Resolving the conversation's last pending request unblocks
  // the session, so its question is marked resolved in the same commit. The
  // resolvePermission side effect runs permissions.updatePermissionStatus.
  // A denial with a reason settles the session's other cards, the same rule
  // the server applies (cascadeFromAnswer), so they leave on the press. What
  // an "always" approves depends on every saved rule, denies included, which
  // only the server holds: those cards leave with its next snapshot.
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
  return matches.length === 1 ? matches[0] : undefined;
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
  if (!current || current.submitted) return false;
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
