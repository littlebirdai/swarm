import { randomUUID } from "node:crypto";
import {
  boundedRuleRequest,
  codexApprovalRequest,
} from "@codecast/policy/permissionRules";
import type {
  ApprovalPolicy,
  ApprovalRequest,
  CodexAppServerOptions,
} from "./codex-app-server.js";
import { holdConversationForPrompt } from "./pendingPromptHold.js";
import {
  handlePermissionRequest,
  settlePermission,
} from "./permissionHandler.js";
import { projectRootOf } from "./permissionHookWait.js";
import { parsePollMessage, type PollMessage } from "./pollMessage.js";
import type { SyncService } from "./syncService.js";

const appServerUserInput = new Map<
  string,
  (poll: PollMessage | null) => void
>();

export async function deliverCodexPromptAnswer(
  threadId: string,
  content: string,
  messageId: string,
  admit: () => Promise<void>,
  syncService: SyncService,
): Promise<"blocked" | "handled" | "none"> {
  const answer = appServerUserInput.get(threadId);
  const poll = parsePollMessage(content);
  if (!poll) return answer ? "blocked" : "none";
  if (answer) {
    await admit();
    if (appServerUserInput.get(threadId) === answer) {
      appServerUserInput.delete(threadId);
      answer(poll);
    }
  }
  await syncService.updateMessageStatus({
    messageId,
    status: "delivered",
    deliveredAt: Date.now(),
  });
  return "handled";
}

export function codexPromptHandlers(
  syncService: SyncService,
  threadFor: (
    threadId: string,
  ) =>
    | { conversationId: string; cwd?: string; approvalPolicy?: ApprovalPolicy }
    | undefined,
  log: (message: string) => void,
  markBlocked: (conversationId: string, threadId: string) => void,
  closePrompt: (
    threadId: string,
    conversationId: string,
    promptId: string,
    resolution: string,
  ) => void,
): Pick<CodexAppServerOptions, "onUserInput" | "onApproval"> & {
  onApprovalRequested: (threadId: string, approval: ApprovalRequest) => void;
} {
  return {
    onUserInput: async (threadId, request, signal) => {
      const entry = threadFor(threadId);
      if (!entry || signal.aborted || appServerUserInput.has(threadId))
        return null;
      const { conversationId } = entry;
      const promptUuid = `interactive-prompt-${threadId}-${randomUUID()}`;
      const { promise, resolve } =
        Promise.withResolvers<ReturnType<typeof parsePollMessage>>();
      const cancel = () => resolve(null);
      appServerUserInput.set(threadId, resolve);
      signal.addEventListener("abort", cancel, { once: true });
      let published = false;
      let resolution = "Codex question cancelled";
      try {
        await syncService.addMessages({
          conversationId,
          messages: [
            {
              messageUuid: promptUuid,
              role: "assistant",
              content: "",
              timestamp: Date.now(),
              toolCalls: [
                {
                  id: promptUuid,
                  name: "AskUserQuestion",
                  input: {
                    questions: request.questions.map(
                      ({ question, header, options }) => ({
                        question,
                        ...(header ? { header } : {}),
                        options,
                      }),
                    ),
                  },
                },
              ],
            },
          ],
        });
        published = true;
        if (!signal.aborted && appServerUserInput.get(threadId) === resolve) {
          holdConversationForPrompt(conversationId);
          markBlocked(conversationId, threadId);
        }
        const poll = await promise;
        const display = poll?.display || poll?.text;
        if (typeof display === "string" && display)
          resolution = `Answered from the app: ${display}`;
        return poll;
      } finally {
        signal.removeEventListener("abort", cancel);
        if (appServerUserInput.get(threadId) === resolve)
          appServerUserInput.delete(threadId);
        if (published) {
          closePrompt(threadId, conversationId, promptUuid, resolution);
        }
      }
    },
    onApproval: async (threadId: string, approval: ApprovalRequest) => {
      const entry = threadFor(threadId);
      if (!entry) return true;
      // The same rules as Claude's calls: a command or an edit settles against
      // codecast's saved approvals before any card, and "always" keeps one.
      // A request of another kind has no rule terms: rules never allow it, and
      // a session nobody watches still gets a decline instead of a wait.
      const ruleRequest = boundedRuleRequest(
        codexApprovalRequest(approval.method, approval.params, {
          cwd: entry.cwd,
          root: projectRootOf(entry.cwd),
        }) ?? {
          permission: approval.method,
          patterns: [],
          always: [],
          opaque: true,
        },
      );
      if (entry.approvalPolicy === "never") {
        // Nobody is asked here, but a configured deny still wins.
        const settled = await settlePermission(
          syncService,
          entry.conversationId,
          ruleRequest,
          log,
        );
        if (settled && !settled.approved && settled.settled === "rule")
          return false;
        log(
          `[codex-app-server] auto-approving ${approval.method} for thread ${threadId.slice(0, 8)} (approvalPolicy=never)`,
        );
        return true;
      }
      const permissionPrompt = {
        tool_name: approval.method,
        arguments_preview: JSON.stringify(approval.params).slice(0, 200),
        ruleRequest,
      };
      try {
        const decision = await handlePermissionRequest(
          syncService,
          entry.conversationId,
          threadId,
          permissionPrompt,
          log,
        );
        return decision?.approved ?? true;
      } catch (err) {
        log(
          `[codex-app-server] approval error: ${err instanceof Error ? err.message : String(err)}`,
        );
        return true;
      }
    },
    onApprovalRequested: (threadId: string, approval: ApprovalRequest) => {
      const entry = threadFor(threadId);
      if (entry && entry.approvalPolicy !== "never") {
        markBlocked(entry.conversationId, threadId);
        syncService
          .createSessionNotification({
            conversation_id: entry.conversationId,
            type: "permission_request" as any,
            title: "codecast - Permission needed",
            message: `${approval.method}: ${JSON.stringify(approval.params).slice(0, 200)}`,
          })
          .catch(() => {});
      }
    },
  };
}
