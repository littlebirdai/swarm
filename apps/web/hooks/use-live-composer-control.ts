import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useCallback, useMemo } from "react";
import {
  selectComposerControl,
  type ComposerControlCommand,
  type ComposerControlFlag,
  type SendState,
  type TurnExpectation,
} from "../components/conversation/composer-control-model";
import { useInboxStore } from "../store/inboxStore";
import type {
  SteerClaimState,
  SteerComposerCommand,
} from "../store/steer-composer-state";
import { entityIdArgs, useSyncCollection } from "./useSyncCollection";

const select = (row: SteerClaimState | null | undefined) =>
  row === undefined ? undefined : row === null ? [] : [row];

function sendState(row: SteerClaimState): SendState | null {
  if (row.delivery === "ambiguous") return { kind: "in-doubt" };
  if (row.delivery === "delivery-started") return { kind: "with-agent" };
  if (!row.queue.items.some((item) => item.sender === row.viewer)) return null;
  if (row.holder && row.holder.id !== row.viewer)
    return { kind: "waiting-for-driver", driver: row.holder.name };
  return { kind: "waiting-for-machine" };
}

function toStoreCommand(
  command: ComposerControlCommand,
  row: SteerClaimState,
): SteerComposerCommand | undefined {
  switch (command.kind) {
    case "send":
    case "queue":
      if (
        command.kind === "send" &&
        command.expected.turn &&
        !command.expected.address
      )
        return;
      return {
        kind: "send",
        clientId: crypto.randomUUID(),
        text: command.text,
        ...(command.imageIds && { imageIds: command.imageIds }),
        ...(command.quoteIds && { quoteIds: command.quoteIds }),
        ...(command.typedWords && { typedWords: command.typedWords }),
        ...(command.kind === "send" &&
          command.expected.address && { observed: command.expected.address }),
      };
    case "ask":
      return { kind: "ask" };
    case "takeover":
      if (command.expected.address && command.expected.batonToken !== undefined)
        return {
          kind: "takeover",
          expected: command.expected.address,
          holder: command.driverId,
          token: command.expected.batonToken,
        };
      return;
    case "cancel-takeover":
      return row.fence_id
        ? { kind: "cancel", fenceId: row.fence_id }
        : undefined;
  }
}

export function useLiveComposerControl(
  conversationId: string | undefined,
  viewerId: string | undefined,
  enabled: boolean,
): ComposerControlFlag | undefined {
  const scope = enabled && viewerId ? conversationId : undefined;
  const dropAbsent = useCallback(
    (row: SteerClaimState) => row._id === scope,
    [scope],
  );
  const args = entityIdArgs("conversation_id", scope);
  useSyncCollection(
    "fencedSteerClaims",
    api.collab.steerClaimState,
    args === "skip"
      ? "skip"
      : { conversation_id: args.conversation_id as Id<"conversations"> },
    { select, dropAbsent },
  );
  const row = useInboxStore((state) =>
    scope ? state.fencedSteerClaims?.[scope] : undefined,
  );
  return useMemo(() => {
    if (!scope || !row || row.viewer !== viewerId) return;
    const expected: TurnExpectation = {
      kind: "turn",
      turn: row.turn?.id ?? null,
      ...(row.turn && { address: row.turn, batonToken: row.baton_token }),
    };
    return {
      enabled: true,
      conversationId: scope,
      shared: {
        facts: {
          viewerId,
          role: row.owner ? "owner" : row.can_send ? "sender" : "viewer",
          driver: row.holder,
          turn: expected.turn,
          expected,
          canSteer: row.can_steer,
          canTakeOver: row.can_take_over,
          takeoverPending: row.takeover_pending,
          driveRequested: row.drive_requested,
          sendState: sendState(row),
          live: true,
        },
        baton: {
          async run(command) {
            const call = toStoreCommand(command, row);
            if (!call) return "refused";
            const result = await useInboxStore
              .getState()
              .controlSteerComposer(scope, call);
            if (
              [
                "acknowledged",
                "pending",
                "granted",
                "cancelled",
                "requested",
              ].includes(result.status)
            )
              return "accepted";
            return result.status === "stale" || result.code === "STALE_TURN"
              ? "stale"
              : "refused";
          },
        },
      },
    };
  }, [row, scope, viewerId]);
}

export function useSessionComposerControl(
  conversationId: string | undefined,
  viewerId: string | undefined,
  fallback: ComposerControlFlag | undefined,
  enabled: boolean,
) {
  const live = useLiveComposerControl(
    conversationId,
    viewerId,
    enabled && !fallback && import.meta.env.VITE_SWARM_TURN_BATON === "1",
  );
  const control = enabled ? (fallback ?? live) : undefined;
  return conversationId && selectComposerControl(control, conversationId)
    ? control
    : undefined;
}
