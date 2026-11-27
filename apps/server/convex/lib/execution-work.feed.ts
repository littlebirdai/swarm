import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { isConversationSafetyBlocked } from "../conversationSafety";
import { forcedDeviceMoveEnabled } from "./edge/device-move.state";
import {
  bindingEvidenceWire,
  executionBinding,
  executionRequestWire,
  watchesOwnedCodexInbox,
} from "./execution-binding.state";
import {
  capabilitiesEqual,
  fail,
  requireNonEmpty,
  requireProtocolCapabilities,
  requireProtocolVersion,
  wireIsolation,
} from "./execution-binding.validators";
import { sessionStartOf } from "./sessionStarts";

export async function executionWorkFor(
  ctx: QueryCtx,
  userId: Id<"users">,
  device: string,
  boundToDevice: boolean,
  args: {
    daemon_boot_id: string;
    protocol_version: number;
    capabilities: Doc<"execution_bindings">["required_capabilities"];
    owned_codex_conversation_id?: string;
  },
) {
  requireNonEmpty(device, "ownerDeviceId");
  requireNonEmpty(args.daemon_boot_id, "daemonBootId");
  requireProtocolVersion(args.protocol_version);
  requireProtocolCapabilities(args.capabilities);
  const heads = await (ctx.db as any)
    .query("conversation_execution_heads")
    .withIndex("by_owner_state", (q: any) =>
      q.eq("owner_user_id", userId).eq("protocol_state", "fenced"),
    )
    .collect();
  const work: any[] = [];
  const useSessionCard = process.env.EXECUTION_WORK_SESSION_CARD === "1";
  const destinationHeads = boundToDevice
    ? (
        await Promise.all(
          (["retarget", "activate"] as const).map((step) =>
            ctx.db
              .query("conversation_execution_heads")
              .withIndex("by_move_destination", (q) =>
                q
                  .eq("device_move.destination_runner_id", userId)
                  .eq("device_move.destination_device_id", device)
                  .eq("device_move.phase", "preparing")
                  .eq("device_move.driver.step", step),
              )
              .take(32),
          ),
        )
      ).flat()
    : [];
  const moving = new Set(destinationHeads.map((head) => head._id));
  for (const head of [
    ...heads.filter(
      (head: Doc<"conversation_execution_heads">) => !head.device_move?.driver,
    ),
    ...destinationHeads,
  ]) {
    const conversationId = head.conversation_id as Id<"conversations">;
    const card = useSessionCard
      ? await sessionStartOf(ctx.db, conversationId)
      : null;
    if (card?.execution_safety_blocked === undefined) {
      const conversation = await ctx.db.get(conversationId);
      if (conversation && isConversationSafetyBlocked(conversation)) continue;
    } else if (card.execution_safety_blocked) {
      continue;
    }
    if (head.protocol_version !== args.protocol_version) {
      fail(
        "EXECUTION_PROTOCOL_VERSION_MISMATCH",
        "stored head differs from daemon handshake",
      );
    }
    const move = moving.has(head._id) ? head.device_move : undefined;
    if (move?.forced && !forcedDeviceMoveEnabled()) continue;
    const epochs = move
      ? [move.next_epoch]
      : [
          ...new Set(
            [head.current_epoch, head.pending_epoch].filter(
              Number.isSafeInteger,
            ),
          ),
        ];
    const bindings = [];
    for (const epoch of epochs) {
      const binding = await executionBinding(
        ctx,
        head.conversation_id,
        epoch as number,
      );
      if (!binding || binding.owner_device_id !== device) continue;
      if (
        move &&
        (binding.move_id !== move.move_id ||
          binding.owner_user_id !== userId ||
          binding.daemon_boot_id !== args.daemon_boot_id)
      )
        continue;
      if (
        !capabilitiesEqual(
          binding.required_capabilities ?? [],
          args.capabilities,
        )
      ) {
        fail(
          "EXECUTION_CAPABILITY_MISMATCH",
          "stored binding differs from daemon handshake",
        );
      }
      const hasRuntimeEvidence =
        binding.state === "ready" ||
        binding.state === "stopped" ||
        binding.state === "quarantined";
      bindings.push({
        state: binding.state,
        daemonBootMatch: binding.daemon_boot_id === args.daemon_boot_id,
        request: executionRequestWire(binding),
        ...(hasRuntimeEvidence && !binding.pre_ready_disposition
          ? { binding: bindingEvidenceWire(binding) }
          : {}),
      });
    }
    const intent = move ? undefined : head.successor_intent;
    const pendingIntent =
      intent?.status === "pending" && intent.owner_device_id === device
        ? {
            intentId: intent.intent_id,
            expectedCurrentEpoch: intent.expected_current_epoch,
            policy: intent.policy,
            request: {
              target: {
                conversationId: String(head.conversation_id),
                epoch: intent.expected_current_epoch + 1,
                requestedAgent: intent.requested_agent,
                transport: intent.transport,
                projectPath: intent.project_path,
                isolation: wireIsolation(intent.isolation),
              },
              configuration: {
                revision: intent.configuration_revision,
                model: intent.model,
                effort: intent.effort,
              },
              ownerDeviceId: intent.owner_device_id,
              daemonBootId: args.daemon_boot_id,
              requiredCapabilities: intent.required_capabilities,
              protocolVersion: intent.protocol_version,
              trigger: "recovery" as const,
            },
          }
        : undefined;
    if (bindings.length > 0 || pendingIntent) {
      work.push({
        conversationId: String(head.conversation_id),
        currentEpoch: head.current_epoch,
        pendingEpoch: head.pending_epoch,
        pendingPolicy: head.pending_policy,
        bindings,
        pendingIntent,
        ...(watchesOwnedCodexInbox(
          args.owned_codex_conversation_id,
          head,
          bindings,
        )
          ? { nextDeliverySequence: head.next_conversation_sequence }
          : {}),
      });
    }
  }
  return work;
}
