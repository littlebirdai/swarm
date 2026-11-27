import { asyncAction } from "./mutativeMiddleware";
import type { api } from "@codecast/convex/convex/_generated/api";
import type { FunctionReturnType } from "convex/server";

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
export type SteerComposerResult = { status: string; code?: string };

export type CollabGrantCommand =
  | { kind: "request"; conversationId: string }
  | { kind: "decide"; grantId: string; allow: boolean }
  | { kind: "revoke"; grantId: string };

type SteerComposerSlice = {
  fencedSteerClaims: Record<string, SteerClaimState>;
  changeCollabGrant: (command: CollabGrantCommand) => Promise<unknown>;
  controlSteerComposer: (
    convId: string,
    command: SteerComposerCommand,
  ) => Promise<SteerComposerResult>;
};

export function createSteerComposerSlice(): SteerComposerSlice {
  return {
    fencedSteerClaims: {},
    changeCollabGrant: asyncAction(function (_command: CollabGrantCommand) {}),
    controlSteerComposer: asyncAction(function (
      _convId: string,
      _command: SteerComposerCommand,
    ) {}),
  } as unknown as SteerComposerSlice;
}
