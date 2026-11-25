import {
  nonEmptyString,
  nullable,
  object,
  oneOf,
  positiveInteger,
  responseObject,
  tagged,
} from "./parse";

const turn = { kind: oneOf("turn"), turn: nullable(nonEmptyString) };
const prompt = { kind: oneOf("prompt"), run: positiveInteger };
const terminal = { kind: oneOf("terminal") };
const paneInstance = positiveInteger;

export const readExpectedTurn = responseObject(turn);
export const readExpected = tagged("kind", {
  turn: readExpectedTurn,
  prompt: responseObject({ ...prompt, prompt_id: nonEmptyString }),
  terminal: responseObject({
    ...terminal,
    pane_instance: paneInstance,
    fencing_token: nonEmptyString,
  }),
});

export const readObservedTurn = object(turn);
export const readObserved = tagged("kind", {
  turn: readObservedTurn,
  prompt: object({ ...prompt, prompt_id: nullable(nonEmptyString) }),
  terminal: object({
    ...terminal,
    pane_instance: nullable(paneInstance),
    fencing_token: nullable(nonEmptyString),
  }),
});

export type PaneInstance = ReturnType<typeof paneInstance>;
export type Expected = ReturnType<typeof readExpected>;
export type Observed = ReturnType<typeof readObserved>;

export function matchesExpected(
  expected: Expected | undefined,
  observed: Observed,
): boolean {
  if (expected === undefined) return true;
  switch (expected.kind) {
    case "turn":
      return observed.kind === "turn" && expected.turn === observed.turn;
    case "prompt":
      return (
        observed.kind === "prompt" &&
        expected.run === observed.run &&
        expected.prompt_id === observed.prompt_id
      );
    case "terminal":
      return (
        observed.kind === "terminal" &&
        expected.pane_instance === observed.pane_instance &&
        expected.fencing_token === observed.fencing_token
      );
  }
}
