import turns from "../../apps/cli/src/__fixtures__/codexCloud/turns.ask.json";

interface RecordedFrame {
  method: string;
  params: {
    threadId?: string;
    turnId?: string;
    item?: {
      type: string;
      id: string;
      text?: string;
      content?: { type: string; text: string }[];
    };
    [key: string]: unknown;
  };
}
function recordedFrames(data: unknown): RecordedFrame[] {
  if (data === null || typeof data !== "object") return [];
  if ("thread_events" in data)
    return (data.thread_events as { events: RecordedFrame[] }).events;
  return Object.values(data).flatMap(recordedFrames);
}
const recording = recordedFrames(turns);
const user = recording.find(
  ({ params }) => params.item?.type === "userMessage",
)!.params.item!;
const assistant = recording.find(
  ({ params }) => params.item?.type === "agentMessage",
)!.params.item!;
const command = recording.find(
  ({ params }) => params.item?.type === "commandExecution",
)!.params.item!;
export const input = user.content![0]!.text;
export const midInput = "Continue with a shorter answer";
export const question = {
  id: "question",
  header: "Output",
  question: "Which output do you want?",
  isOther: false,
  isSecret: false,
  options: [
    { label: "Short", description: "One line" },
    { label: "Full", description: "All details" },
  ],
};

export function recordedItems(threadId: string, turnId: string) {
  return recording
    .filter(
      ({ method }) =>
        method === "item/completed" || method === "rawResponseItem/completed",
    )
    .map((frame) => ({
      ...frame,
      params: {
        ...frame.params,
        threadId,
        turnId,
        item: {
          ...frame.params.item,
          id: `${turnId}:${frame.params.item!.id}`,
        },
      },
    }));
}

export function recordedCompletion(
  threadId: string,
  id: string,
  status: string,
) {
  const completion = recording.find(
    ({ method }) => method === "turn/completed",
  )!;
  return {
    ...completion,
    params: {
      threadId,
      turn: { ...(completion.params.turn as object), id, status },
    },
  };
}

export const recordedAssistantId = (turnId: string) =>
  `${turnId}:${assistant.id}`;
export const recordedToolId = (turnId: string) => `${turnId}:${command.id}`;

const aliases = new Map([
  [user.id, "user"],
  [assistant.id, "assistant"],
  [command.id, "command"],
]);
export function normalizeId(id: string) {
  return id
    .replace(/^(legacy|adapter)-/, "")
    .replace(/:([^:]+)$/, (suffix, native: string) =>
      aliases.has(native) ? `:${aliases.get(native)}` : suffix,
    );
}

const commandPayload = command as typeof command & {
  command: string;
  aggregatedOutput: string;
};
export function labelText(text: string) {
  if (text === input) return "recorded-input";
  if (text === midInput) return "mid-input";
  if (text === assistant.text) return "recorded-answer";
  if (text === commandPayload.command) return "recorded-command";
  if (text === commandPayload.aggregatedOutput) return "recorded-output";
  return `text:${Bun.hash(text).toString(16)}`;
}
