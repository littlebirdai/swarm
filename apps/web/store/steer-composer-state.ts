import { asyncAction, sync } from "./mutativeMiddleware";
import type { InboxStoreState } from "./inboxStore";
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
type SteeringControl = Exclude<SteerComposerCommand, { kind: "send" }>;
type SteeringSend = Extract<SteerComposerCommand, { kind: "send" }>;
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
  command?: Extract<
    ComposerControlCommand,
    { kind: "send" | "queue" | "suggest" }
  >;
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

type State = {
  fencedSteerClaims: Record<string, SteerClaimState>;
  collabAccess: Record<string, CollabAccess>;
  collabRequests: Record<string, CollabRequest>;
  composerOperations: Record<string, ComposerOperation>;
};
type Draft = State & Pick<InboxStoreState, "pending">;
type SteerComposerSlice = State & {
  updateComposerOperation: (id: string, value: ComposerOperation) => void;
  changeCollabGrant: (command: CollabGrantCommand) => Promise<unknown>;
  controlSteerComposer: (
    convId: string,
    command: SteeringControl,
  ) => Promise<SteerComposerResult>;
  sendSteerComposer: (
    convId: string,
    command: SteeringSend,
  ) => Promise<SteerComposerResult>;
  retireSteerControl: (id: string) => void;
  settleCollabCommand: (
    action: string,
    args: unknown[],
    result: unknown,
    locks: ReadonlySet<string>,
  ) => void;
};
type Store = {
  _dispatch: (action: string, args: unknown[]) => Promise<SteerComposerResult>;
};

export function canStopSteerCommand(row: SteerClaimState, expected: SteerTurn) {
  return (
    row.turn?.id === expected.id &&
    row.turn.run === expected.run &&
    row.turn.start_event_seq === expected.start_event_seq
  );
}

export function createSteerComposerSlice(get: () => Store): SteerComposerSlice {
  return {
    fencedSteerClaims: {},
    collabAccess: {},
    collabRequests: {},
    composerOperations: {},
    updateComposerOperation: sync(function (
      this: State,
      id: string,
      value: ComposerOperation,
    ) {
      this.composerOperations[id] = value;
    }),
    changeCollabGrant: asyncAction(function (
      this: Draft,
      command: CollabGrantCommand,
    ) {
      if (command.kind === "request") {
        const id = command.conversationId;
        this.collabAccess[id] = {
          ...this.collabAccess[id],
          _id: id,
          level: "requested",
        };
      } else {
        const row = this.collabRequests[command.grantId];
        if (row)
          row.status =
            command.kind === "revoke"
              ? "revoked"
              : command.allow
                ? "granted"
                : "denied";
      }
    }),
    controlSteerComposer: asyncAction(function (
      this: Draft,
      id: string,
      command: SteeringControl,
    ) {
      const row = this.fencedSteerClaims[id];
      if (!row) return;
      switch (command.kind) {
        case "ask":
          row.drive_requested = true;
          return;
        case "takeover":
          row.takeover_pending = true;
          return;
        case "cancel":
          row.takeover_pending = false;
          row.fence_id = null;
          return;
      }
    }),
    sendSteerComposer: (id: string, command: SteeringSend) =>
      get()._dispatch("controlSteerComposer", [id, command]),
    retireSteerControl: sync(function (this: Draft, id: string) {
      for (const field of ["takeover_pending", "fence_id", "drive_requested"])
        delete this.pending[`fencedSteerClaims:${id}:${field}`];
    }),
    settleCollabCommand: sync(function (
      this: Draft,
      action: string,
      args: unknown[],
      result: unknown,
      locks: ReadonlySet<string>,
    ) {
      if (!result || typeof result !== "object") return;
      const retire = (key: string) => {
        const entry = this.pending[key];
        if (!entry?.lock || !locks.has(entry.lock)) return false;
        delete this.pending[key];
        return true;
      };
      if (
        action === "controlSteerComposer" &&
        "status" in result &&
        result.status === "granted"
      ) {
        const [id] = args as [string];
        const row = this.fencedSteerClaims[id];
        if (retire(`fencedSteerClaims:${id}:takeover_pending`) && row)
          row.takeover_pending = false;
      } else if (action === "changeCollabGrant") {
        const [command] = args as [CollabGrantCommand];
        if (
          command.kind === "request" &&
          "level" in result &&
          result.level !== "requested"
        ) {
          const id = command.conversationId;
          if (
            retire(`collabAccess:${id}:level`) ||
            retire(`collabAccess:${id}`)
          )
            this.collabAccess[id] = { ...(result as CollabAccess), _id: id };
        } else if (
          command.kind !== "request" &&
          "status" in result &&
          (result.status === "revoked" ||
            result.status === "denied" ||
            result.status === "gone")
        ) {
          const id = command.grantId;
          if (retire(`collabRequests:${id}:status`))
            delete this.collabRequests[id];
        }
      }
    }),
  } as unknown as SteerComposerSlice;
}
