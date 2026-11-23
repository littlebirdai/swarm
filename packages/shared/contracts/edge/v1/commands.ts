import { json, nonEmptyString, object, oneOf, optional, parser, tagged } from "./parse";
import { readV1 } from "./version";
import { fence } from "./claims";
import { daemon } from "./link";

const command = { command_id: nonEmptyString, name: nonEmptyString, args: json };
const commandsNextRequest = object({ v: readV1, ...daemon });
const commandsNextResponse = tagged("status", {
  command: object({ v: readV1, status: oneOf("command"), ...command, claim: optional(object(fence)) }),
  empty: object({ v: readV1, status: oneOf("empty") }),
});
const commandsResultRequest = object({
  v: readV1,
  ...daemon,
  command_id: nonEmptyString,
  claim: optional(object(fence)),
  outcome: oneOf("completed", "failed", "unsupported"),
  output: json,
});
const commandsResultResponse = object({ v: readV1, status: oneOf("recorded", "duplicate", "stale") });

export type CommandsNextRequest = ReturnType<typeof commandsNextRequest>;
export type CommandsNextResponse = ReturnType<typeof commandsNextResponse>;
export type CommandsResultRequest = ReturnType<typeof commandsResultRequest>;
export type CommandsResultResponse = ReturnType<typeof commandsResultResponse>;

export const parseCommandsNextRequest = parser(commandsNextRequest);
export const parseCommandsNextResponse = parser(commandsNextResponse);
export const parseCommandsResultRequest = parser(commandsResultRequest);
export const parseCommandsResultResponse = parser(commandsResultResponse);
