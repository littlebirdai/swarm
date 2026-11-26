import type { CanonicalEvent } from "@codecast/edge-contract";
import { sessionMachine, type SessionState } from "./session-machine";

export const TURN_PROJECTION_VERSION = 1;
export const TURN_STARTER_PROJECTION_VERSION = 2;

export type TurnProjection = Readonly<
  Pick<SessionState, "session" | "run" | "status" | "eventSeq" | "turnIds"> & {
    openTurn: {
      readonly id: string;
      readonly promptIds: readonly string[];
      readonly starter?: SessionState["turn"]["starter"];
    } | null;
  }
>;

export function projectTurn(
  projection: TurnProjection,
  events: readonly CanonicalEvent[],
): TurnProjection {
  const { session, run, status, eventSeq, turnIds, openTurn } = projection;
  const initial = sessionMachine.initial({ session, run });
  const lastTurn = turnIds.at(-1);
  let state: SessionState = {
    ...initial,
    status,
    runStatus: "ready",
    eventSeq,
    turnIds,
    turn: openTurn
      ? {
          ...initial.turn,
          id: openTurn.id,
          status: openTurn.promptIds.length ? "blocked" : "running",
          ...(openTurn.starter && { starter: openTurn.starter }),
          prompts: openTurn.promptIds.map((id) => ({
            id,
            answerRequested: false,
          })),
        }
      : lastTurn === undefined
        ? initial.turn
        : { ...initial.turn, id: lastTurn, status: "ended" },
  };

  for (const event of events)
    state = sessionMachine.apply(state, {
      kind: "provider.event",
      event,
    }).state;

  return {
    session,
    run,
    status: state.status,
    eventSeq: state.eventSeq,
    turnIds: state.turnIds,
    openTurn:
      state.turn.id !== null &&
      (state.turn.status === "running" || state.turn.status === "blocked")
        ? {
            id: state.turn.id,
            promptIds: state.turn.prompts.map(({ id }) => id),
            ...(state.turn.starter && { starter: state.turn.starter }),
          }
        : null,
  };
}
