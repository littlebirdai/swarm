import { sync } from "./mutativeMiddleware";
import type { api } from "@codecast/convex/convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import type {
  ComposerControlCommand,
  ComposerPayload,
  SendState,
} from "../components/conversation/composer-control-model";

export type SteerClaimState = NonNullable<
  FunctionReturnType<typeof api.collab.steerClaimState>
>;
export type SteerTurn = NonNullable<SteerClaimState["turn"]>;
type SteerClaimRow = SteerClaimState & { feedVersion?: string };
export type SteerComposerCommand =
  | { kind: "ask" }
  | { kind: "cancel"; fenceId: string }
  | {
      kind: "takeover";
      expected: SteerTurn;
      holder: string;
      token: number | null;
    }
  | {
      kind: "send";
      clientId: string;
      text: string;
      imageIds?: string[];
      quoteIds?: string[];
      typedWords?: string;
      observed?: SteerTurn;
    };
export type SteerComposerResult = { status: string; code?: string };

export type CollabGrantCommand =
  | { kind: "request"; conversationId: string }
  | { kind: "decide"; grantId: string; allow: boolean }
  | { kind: "revoke"; grantId: string };
export type CollabAccess = FunctionReturnType<
  typeof api.collab.mySendAccess
> & {
  _id: string;
};
export type CollabRequest = FunctionReturnType<
  typeof api.collab.collabRequests
>[number] & {
  _id: string;
  conversation_id: string;
};

export type ComposerControlCommandKey =
  | Exclude<ComposerControlCommand, ComposerPayload>["kind"]
  | "submit";
export type ComposerObservation = { key: string };
export type ComposerRetry = {
  id: string;
  payload: ComposerPayload;
  command?: ComposerControlCommand;
};
export type ComposerOutcome = {
  observation: ComposerObservation;
  completed: ReadonlySet<ComposerControlCommandKey>;
  send?: { receipt: ComposerObservation; state: SendState };
  controlError?: "refused" | "in-doubt";
};
export type ComposerOperation = {
  observation?: ComposerObservation;
  receipt?: ComposerObservation;
  pending: ReadonlyMap<ComposerControlCommandKey, ComposerObservation>;
  outcome?: ComposerOutcome;
  retries: ComposerRetry[];
};

type SteerFacts = Partial<
  Pick<SteerClaimState, "takeover_pending" | "drive_requested" | "fence_id">
>;
type State = {
  fencedSteerClaims: Record<string, SteerClaimRow>;
  collabAccess: Record<string, CollabAccess>;
  collabRequests: Record<string, CollabRequest>;
  composerOperations: Record<string, ComposerOperation>;
};
type Dispatch = (
  action: string,
  args: unknown[],
) => Promise<SteerComposerResult>;
type SteerComposerSlice = State & {
  updateComposerOperation: (id: string, value: ComposerOperation) => void;
  paintSteerFacts: (
    id: string,
    before: SteerClaimRow,
    changes: SteerFacts,
  ) => void;
  paintCollabAccess: (
    id: string,
    before: CollabAccess["level"] | undefined,
    next: CollabAccess | undefined,
  ) => void;
  paintCollabRequest: (
    id: string,
    before: CollabRequest["status"],
    status: CollabRequest["status"],
    updatedAt: number,
  ) => void;
  changeCollabGrant: (command: CollabGrantCommand) => Promise<unknown>;
  controlSteerComposer: (
    convId: string,
    command: SteerComposerCommand,
  ) => Promise<SteerComposerResult>;
};
type Store = SteerComposerSlice & { _dispatch: Dispatch };

export function canStopSteerCommand(row: SteerClaimState, expected: SteerTurn) {
  return (
    row.turn?.id === expected.id &&
    row.turn.run === expected.run &&
    row.turn.start_event_seq === expected.start_event_seq
  );
}

function optimisticSteer(command: SteerComposerCommand): SteerFacts {
  switch (command.kind) {
    case "ask":
      return { drive_requested: true };
    case "takeover":
      return { takeover_pending: true, fence_id: null };
    case "cancel":
      return { takeover_pending: false, fence_id: null };
    case "send":
      return {};
  }
}

export function createSteerComposerSlice(get: () => Store): SteerComposerSlice {
  return {
    fencedSteerClaims: {},
    collabAccess: {},
    collabRequests: {},
    composerOperations: {},
    updateComposerOperation: sync(function (this: State, id, value) {
      this.composerOperations[id] = value;
    }),
    paintSteerFacts: sync(function (this: State, id, before, changes) {
      const row = this.fencedSteerClaims[id];
      if (
        !row ||
        row.viewer !== before.viewer ||
        row.feedVersion !== before.feedVersion ||
        row.turn?.id !== before.turn?.id ||
        row.turn?.run !== before.turn?.run ||
        row.turn?.start_event_seq !== before.turn?.start_event_seq ||
        row.baton_token !== before.baton_token ||
        row.takeover_pending !== before.takeover_pending ||
        row.fence_id !== before.fence_id ||
        row.drive_requested !== before.drive_requested
      )
        return;
      Object.assign(row, changes);
    }),
    paintCollabAccess: sync(function (this: State, id, before, next) {
      if (this.collabAccess[id]?.level !== before) return;
      if (next) this.collabAccess[id] = next;
      else delete this.collabAccess[id];
    }),
    paintCollabRequest: sync(
      function (this: State, id, before, status, updatedAt) {
        const row = this.collabRequests[id];
        if (row && row.status === before && row.updated_at === updatedAt)
          row.status = status;
      },
    ),
    async changeCollabGrant(command) {
      if (command.kind === "request") {
        const id = command.conversationId;
        const before = get().collabAccess[id];
        if (before?.level === "requested") return;
        get().paintCollabAccess(id, before?.level, {
          ...before,
          _id: id,
          level: "requested",
        });
        try {
          const response = await get()._dispatch("changeCollabGrant", [
            command,
          ]);
          const confirmed = response as unknown as Omit<CollabAccess, "_id">;
          if (confirmed.level !== "requested")
            get().paintCollabAccess(id, "requested", { ...confirmed, _id: id });
          return response;
        } catch (error) {
          get().paintCollabAccess(id, "requested", before);
          throw error;
        }
      }
      const { grantId } = command;
      const row = get().collabRequests[grantId];
      if (!row) return;
      const { status: before, updated_at: updatedAt } = row;
      if (before !== "requested" && before !== "granted") return;
      const status =
        command.kind === "revoke"
          ? "revoked"
          : command.allow
            ? "granted"
            : "denied";
      if ((command.kind === "revoke") !== (before === "granted")) return;
      get().paintCollabRequest(grantId, before, status, updatedAt);
      try {
        return await get()._dispatch("changeCollabGrant", [command]);
      } catch (error) {
        get().paintCollabRequest(grantId, status, before, updatedAt);
        throw error;
      }
    },
    async controlSteerComposer(id, command) {
      const before = get().fencedSteerClaims[id];
      if (!before) return { status: "refused" };
      if (
        (command.kind === "ask" && before.drive_requested) ||
        (command.kind === "takeover" && before.takeover_pending) ||
        (command.kind === "cancel" && before.fence_id !== command.fenceId)
      )
        return { status: "refused" };
      const changes = optimisticSteer(command);
      function rollback() {
        get().paintSteerFacts(
          id,
          { ...before, ...changes },
          {
            takeover_pending: before.takeover_pending,
            drive_requested: before.drive_requested,
            fence_id: before.fence_id,
          },
        );
      }
      if (command.kind !== "send") get().paintSteerFacts(id, before, changes);
      try {
        const result = await get()._dispatch("controlSteerComposer", [
          id,
          command,
        ]);
        if (
          command.kind !== "send" &&
          !["requested", "pending", "granted", "cancelled"].includes(
            result.status,
          )
        )
          rollback();
        return result;
      } catch (error) {
        if (command.kind !== "send") rollback();
        throw error;
      }
    },
  };
}
