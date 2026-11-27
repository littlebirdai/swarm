import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { createElement, useCallback, useMemo, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { commandsSession } from "@codecast/inbox/inboxProjection";
import {
  selectComposerControl,
  type ComposerControlCommand,
  type ComposerControlFlag,
  type SendState,
  type TurnExpectation,
} from "../components/conversation/composer-control-model";
import { useInboxStore } from "../store/inboxStore";
import {
  canStopSteerCommand,
  type SteerClaimState,
  type SteerComposerCommand,
} from "../store/steer-composer-state";
import { entityIdArgs, useSyncCollection } from "./useSyncCollection";

function sendState(
  kind: string | null,
  driver: string | undefined,
): SendState | null {
  if (kind === "ambiguous") return { kind: "in-doubt" };
  if (kind === "delivery-started") return { kind: "with-agent" };
  if (kind !== "queued") return null;
  return driver
    ? { kind: "waiting-for-driver", driver }
    : { kind: "waiting-for-machine" };
}

function toStoreCommand(
  command: ComposerControlCommand,
  fenceId: string | null,
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
        clientId: command.clientId ?? crypto.randomUUID(),
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
      return fenceId ? { kind: "cancel", fenceId } : undefined;
  }
}

export function SteerClaimFeeder({
  scope,
  viewerId,
}: {
  scope: string;
  viewerId: string;
}) {
  const prior = useRef<{ scope: string; signature: string } | undefined>(
    undefined,
  );
  const select = useCallback(
    (row: SteerClaimState | null | undefined) => {
      if (
        row === undefined ||
        (row && (row._id !== scope || row.viewer !== viewerId))
      )
        return;
      if (!row) {
        prior.current = undefined;
        return [];
      }
      const { fresh_for_ms: _fresh, ...facts } = row;
      const signature = JSON.stringify(facts);
      if (
        prior.current?.scope === scope &&
        prior.current.signature === signature &&
        useInboxStore.getState().fencedSteerClaims[scope]?.viewer === viewerId
      )
        return;
      prior.current = { scope, signature };
      return [{ ...row, feedVersion: crypto.randomUUID() }];
    },
    [scope, viewerId],
  );
  const dropAbsent = useCallback(
    (row: SteerClaimState) => row._id === scope,
    [scope],
  );
  useSyncCollection(
    "fencedSteerClaims",
    api.collab.steerClaimState,
    { conversation_id: scope as Id<"conversations"> },
    { select, dropAbsent },
  );
  return null;
}

export function useLiveComposerControl(
  scope: string | undefined,
  viewerId: string | undefined,
): ComposerControlFlag | undefined {
  const row = useInboxStore(
    useShallow((state) => {
      const row = scope ? state.fencedSteerClaims[scope] : undefined;
      if (!row || row.viewer !== viewerId || !scope) return null;
      return {
        owner: row.owner,
        turn: row.turn?.id ?? null,
        run: row.turn?.run,
        startEvent: row.turn?.start_event_seq,
        holderId: row.holder?.id,
        holderName: row.holder?.name,
        baton_token: row.baton_token,
        can_steer: row.can_steer,
        can_take_over: row.can_take_over,
        canInterrupt:
          row.owner ||
          commandsSession(
            state.conversations[scope] ?? state.sessions[scope] ?? {},
            viewerId,
          ),
        fence_id: row.fence_id,
        takeover_pending: row.takeover_pending,
        drive_requested: row.drive_requested,
        can_send: row.can_send,
        delivery:
          row.delivery ??
          (row.queue.items.some((item) => item.sender === viewerId)
            ? "queued"
            : null),
      };
    }),
  );
  return useMemo(() => {
    if (!scope || !row || !viewerId) return;
    const expected: TurnExpectation = {
      kind: "turn",
      turn: row.turn,
      ...(row.turn !== null &&
        row.run !== undefined &&
        row.startEvent !== undefined && {
          address: {
            id: row.turn,
            run: row.run,
            start_event_seq: row.startEvent,
          },
          batonToken: row.baton_token,
        }),
    };
    return {
      enabled: true,
      conversationId: scope,
      shared: {
        facts: {
          viewerId,
          role: row.owner ? "owner" : row.can_send ? "sender" : "viewer",
          driver:
            row.holderId && row.holderName !== undefined
              ? { id: row.holderId, name: row.holderName }
              : null,
          turn: expected.turn,
          expected,
          canSteer: row.can_steer,
          canInterrupt: row.canInterrupt,
          canTakeOver: row.can_take_over,
          canCancelTakeover: row.fence_id !== null,
          takeoverPending: row.takeover_pending,
          driveRequested: row.drive_requested,
          sendState: sendState(
            row.delivery,
            row.holderId !== viewerId ? row.holderName : undefined,
          ),
          live: true,
        },
        baton: {
          async run(command) {
            if (command.kind === "interrupt") {
              const store = useInboxStore.getState();
              const current = store.fencedSteerClaims[scope];
              if (
                !current ||
                current.viewer !== viewerId ||
                !command.expected.address ||
                !canStopSteerCommand(current, command.expected.address) ||
                !(
                  current.owner ||
                  commandsSession(
                    store.conversations[scope] ?? store.sessions[scope] ?? {},
                    viewerId,
                  )
                )
              )
                return "refused";
              await store.sendEscape(scope);
              return "accepted";
            }
            const call = toStoreCommand(command, row.fence_id);
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
  const args = entityIdArgs(
    "conversation_id",
    enabled &&
      !fallback &&
      viewerId &&
      import.meta.env.VITE_SWARM_TURN_BATON === "1"
      ? conversationId
      : undefined,
  );
  const scope = args === "skip" ? undefined : args.conversation_id;
  const live = useLiveComposerControl(scope, viewerId);
  const control = enabled ? (fallback ?? live) : undefined;
  return {
    control:
      conversationId && selectComposerControl(control, conversationId)
        ? control
        : undefined,
    feeder:
      scope && viewerId
        ? createElement(SteerClaimFeeder, { scope, viewerId })
        : null,
  };
}
