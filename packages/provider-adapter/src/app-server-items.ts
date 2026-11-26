import type { EdgeJson } from "@codecast/edge-contract";
import type { SteerRequest } from "@codecast/provider-contract";
import type { Input, ThreadItem } from "./app-server-schema";
import { deliveryClientId } from "./app-server-receipts";
import type { DurablePayload } from "./provider-events";

export function wireInput(input: SteerRequest["input"]) {
  return input.map((part): Input =>
    part.type === "text" ? part : { type: "localImage", path: part.path },
  );
}

const failed = new Set(["failed", "declined"]);
const itemLimit = 4_096;

export function turnItems(
  durable: (payload: DurablePayload) => void,
  delta: (body: { message_id: string; offset: number; text: string }) => void,
) {
  const seen = new Set<string>();
  const tools = new Set<string>();
  const offsets = new Map<string, number>();
  const userInputs = new Map<number, SteerRequest>();
  function remember<T>(set: Set<T>, key: T) {
    if (set.size === itemLimit) {
      for (const oldest of set) {
        set.delete(oldest);
        break;
      }
    }
    set.add(key);
  }

  function tool(
    item: ThreadItem,
    name: string,
    input: EdgeJson,
    output: EdgeJson,
    is_error: boolean,
    ended: boolean,
  ) {
    if (!tools.has(item.id)) {
      remember(tools, item.id);
      durable({ kind: "tool.call", body: { call_id: item.id, name, input } });
    }
    if (ended) {
      tools.delete(item.id);
      durable({
        kind: "tool.result",
        body: { call_id: item.id, output: { inline: output }, is_error },
      });
    }
  }

  function project(item: ThreadItem, ended: boolean) {
    if (seen.has(item.id)) return;
    if (ended) {
      remember(seen, item.id);
      offsets.delete(item.id);
    }
    switch (item.type) {
      case "userMessage": {
        if (!ended) break;
        const text = item.content
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("\n");
        const match = [...userInputs].find(([, request]) => {
          if (item.clientId)
            return item.clientId === deliveryClientId(request.delivery_id);
          const input = wireInput(request.input);
          return (
            input.length === item.content.length &&
            input.every((part, index) => {
              const echo = item.content[index];
              return part.type === "text"
                ? echo?.type === "text" && part.text === echo.text
                : echo?.type === "localImage" && part.path === echo.path;
            })
          );
        });
        if (match) userInputs.delete(match[0]);
        durable({
          kind: "message.user",
          body: {
            text,
            authors: match ? [...match[1].authors] : [],
            ...(match ? { delivery_id: match[1].delivery_id } : {}),
          },
        });
        break;
      }
      case "agentMessage":
        if (ended)
          durable({
            kind: "message.assistant",
            body: { message_id: item.id, text: item.text },
          });
        break;
      case "commandExecution":
        tool(
          item,
          item.type,
          { command: item.command, cwd: item.cwd ?? null },
          item.aggregatedOutput ?? "",
          failed.has(item.status),
          ended,
        );
        break;
      case "fileChange":
        tool(
          item,
          item.type,
          { paths: item.changes.map((change) => change.path ?? null) },
          item.changes,
          failed.has(item.status),
          ended,
        );
        break;
      case "mcpToolCall":
        tool(
          item,
          `${item.server}/${item.tool}`,
          item.arguments,
          item.result ?? item.error ?? null,
          failed.has(item.status),
          ended,
        );
        break;
      case "dynamicToolCall":
        tool(
          item,
          item.tool,
          item.arguments,
          item.contentItems ?? null,
          item.success === false || failed.has(item.status),
          ended,
        );
        break;
      case "collabAgentToolCall":
        tool(
          item,
          item.tool,
          { sender: item.senderThreadId, prompt: item.prompt ?? null },
          item.receiverThreadIds,
          failed.has(item.status),
          ended,
        );
        break;
      case "webSearch":
        tool(item, item.type, { query: item.query }, null, false, ended);
        break;
      case "contextCompaction":
      case "reasoning":
      case "plan":
      case "imageView":
      case "imageGeneration":
        if (ended)
          durable({
            kind: "context",
            body: {
              data: {
                ...item,
                ...(item.type === "reasoning"
                  ? { content: [...item.content], summary: [...item.summary] }
                  : {}),
              } as EdgeJson,
            },
          });
        break;
    }
  }

  return {
    project,
    associate(id: number, request: SteerRequest) {
      if (userInputs.size < 32) userInputs.set(id, request);
    },
    reject: (id: number) => userInputs.delete(id),
    assistantDelta(itemId: string, text: string) {
      if (seen.has(itemId) || !text) return;
      if (!offsets.has(itemId) && offsets.size >= itemLimit) return;
      const offset = offsets.get(itemId) ?? 0;
      delta({ message_id: itemId, offset, text });
      offsets.set(itemId, offset + text.length);
    },
    outputDelta(itemId: string, text: string) {
      if (seen.has(itemId) || !text) return;
      durable({
        kind: "context",
        body: { data: { item_id: itemId, output_delta: text } },
      });
    },
  };
}
