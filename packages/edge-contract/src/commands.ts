import {
  json,
  nonEmptyString,
  object,
  oneOf,
  optional,
  owns,
  parser,
  responseObject,
  tagged,
} from "./parse";
import { readV1 } from "./version";
import { response } from "./response";
import { fence } from "./claims";
import { daemon } from "./link";
import { readExpected, readObserved } from "./expected";
import { validatePromptAnswer } from "./prompts";

const readCommand = responseObject({
  v: readV1,
  status: oneOf("command"),
  command_id: nonEmptyString,
  name: nonEmptyString,
  args: json,
  claim: optional(responseObject(fence)),
  expected: optional(readExpected),
});
const commandsNextRequest = object({ v: readV1, ...daemon });
const commandsNextResponse = response(
  tagged("status", {
    command: (value, path) => {
      const command = readCommand(value, path);
      const { args } = command;
      if (
        command.name === "prompt_answer" &&
        args !== null &&
        typeof args === "object" &&
        !Array.isArray(args) &&
        owns(args, "answer")
      ) {
        validatePromptAnswer(args.answer, `${path}.args.answer`);
      }
      return command;
    },
    empty: responseObject({ v: readV1, status: oneOf("empty") }),
  }),
);
const commandResult = {
  v: readV1,
  ...daemon,
  command_id: nonEmptyString,
  claim: optional(object(fence)),
};
const finishedCommand = object({
  ...commandResult,
  outcome: oneOf("completed", "failed", "unsupported"),
  output: json,
});
const commandsResultRequest = tagged("outcome", {
  completed: finishedCommand,
  failed: finishedCommand,
  unsupported: finishedCommand,
  stale: object({
    ...commandResult,
    outcome: oneOf("stale"),
    observed: readObserved,
  }),
});
const commandsResultResponse = response(
  responseObject({
    v: readV1,
    status: oneOf("recorded", "duplicate", "stale"),
  }),
);

export type CommandsNextRequest = ReturnType<typeof commandsNextRequest>;
export type CommandsNextResponse = ReturnType<typeof commandsNextResponse>;
export type CommandsResultRequest = ReturnType<typeof commandsResultRequest>;
export type CommandsResultResponse = ReturnType<typeof commandsResultResponse>;

export const parseCommandsNextRequest = parser(commandsNextRequest);
export const parseCommandsNextResponse = parser(commandsNextResponse);
export const parseCommandsResultRequest = parser(commandsResultRequest);
export const parseCommandsResultResponse = parser(commandsResultResponse);
