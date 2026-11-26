import type { CanonicalEvent } from "@codecast/edge-contract";
import type { RawProviderFrame } from "@codecast/provider-adapter";
import type { CodexTurnError } from "@codecast/agent-clients/apiErrorBanner";
import {
  threadItemToMessage,
  threadItemsToMessages,
  type ThreadItem,
} from "../codexAppServer.js";
import { codexTurnErrorMessage } from "../codexTurnError.js";
import type { ParsedMessage } from "../parser.js";

export type CodexPilotDisplayEffect =
  | { type: "statusChanged"; status: { type: string; activeFlags?: string[] } }
  | { type: "threadNameUpdated"; name: string }
  | { type: "itemStarted"; message: ParsedMessage }
  | { type: "error"; message: string }
  | { type: "messages"; messages: ParsedMessage[] };

export type CodexPilotDisplaySink = (
  effect: CodexPilotDisplayEffect,
) => void | Promise<void>;

type RawItem = Extract<
  ThreadItem,
  {
    type:
      | "commandExecution"
      | "fileChange"
      | "mcpToolCall"
      | "dynamicToolCall"
      | "collabAgentToolCall"
      | "webSearch"
      | "plan"
      | "reasoning"
      | "imageView"
      | "imageGeneration";
  }
>;

type ItemFrame = { start?: RawItem; end?: RawItem };

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function readItem(value: unknown): RawItem | undefined {
  const item = record(value);
  const id = string(item?.id);
  if (!item || !id) return;
  const status = string(item.status) ?? "";
  const args = item.arguments;
  switch (item.type) {
    case "commandExecution": {
      const command = string(item.command);
      if (command !== undefined)
        return {
          type: item.type,
          id,
          command,
          status,
          cwd: string(item.cwd),
          aggregatedOutput: string(item.aggregatedOutput),
        };
      break;
    }
    case "fileChange": {
      if (!Array.isArray(item.changes)) break;
      const changes = item.changes.flatMap((value: unknown) => {
        const change = record(value);
        const path = string(change?.path);
        const diff = string(change?.diff);
        const kind = string(change?.kind) ?? string(record(change?.kind)?.type);
        return path && diff !== undefined && kind ? [{ path, diff, kind }] : [];
      });
      return { type: item.type, id, status, changes };
    }
    case "mcpToolCall": {
      const server = string(item.server);
      const tool = string(item.tool);
      if (!server || !tool) break;
      const result = record(item.result)?.content;
      const error = string(record(item.error)?.message);
      return {
        type: item.type,
        id,
        status,
        server,
        tool,
        arguments: args,
        ...(Array.isArray(result) ? { result: { content: result } } : {}),
        ...(error !== undefined ? { error: { message: error } } : {}),
      };
    }
    case "dynamicToolCall": {
      const tool = string(item.tool);
      if (!tool) break;
      return {
        type: item.type,
        id,
        status,
        tool,
        arguments: args,
        success: typeof item.success === "boolean" ? item.success : undefined,
        contentItems: Array.isArray(item.contentItems)
          ? item.contentItems.flatMap((value: unknown) => {
              const entry = record(value);
              const type = string(entry?.type);
              return type ? [{ type, text: string(entry?.text) }] : [];
            })
          : undefined,
      };
    }
    case "collabAgentToolCall": {
      const tool = string(item.tool);
      const senderThreadId = string(item.senderThreadId);
      const receiverThreadIds = strings(item.receiverThreadIds);
      if (tool && senderThreadId && receiverThreadIds)
        return {
          type: item.type,
          id,
          tool,
          status,
          senderThreadId,
          receiverThreadIds,
          prompt: string(item.prompt),
        };
      break;
    }
    case "webSearch": {
      const query = string(item.query);
      if (query !== undefined) return { type: item.type, id, query };
      break;
    }
    case "plan": {
      const text = string(item.text);
      if (text !== undefined) return { type: item.type, id, text };
      break;
    }
    case "reasoning": {
      const content = strings(item.content);
      const summary = strings(item.summary);
      if (content && summary) return { type: item.type, id, content, summary };
      break;
    }
    case "imageView": {
      const path = string(item.path);
      if (path) return { type: item.type, id, path };
      break;
    }
    case "imageGeneration": {
      const result = string(item.result);
      if (result !== undefined) return { type: item.type, id, result, status };
      break;
    }
  }
}

function errorCode(value: unknown): Pick<CodexTurnError, "codexErrorInfo"> {
  const error = record(value);
  const code = error?.codexErrorInfo ?? error?.codex_error_info ?? error?.code;
  return { codexErrorInfo: typeof code === "string" ? code : record(code) };
}

function frameKey(thread: string, turn: string, item?: string): string {
  return JSON.stringify([thread, turn, item]);
}

function remember<T>(entries: Map<string, T>, key: string, value: T): void {
  if (entries.size >= 128 && !entries.has(key)) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }
  entries.set(key, value);
}

export class CodexPilotDisplay {
  private readonly rawItems = new Map<string, ItemFrame>();
  private readonly rawErrors = new Map<
    string,
    Pick<CodexTurnError, "codexErrorInfo">
  >();
  private readonly turns = new Map<
    string,
    { items: ThreadItem[]; banner?: ParsedMessage }
  >();

  retain(frame: RawProviderFrame): void {
    if (frame.disposition !== "decoded" || frame.base64Fragment) return;
    const message = record(JSON.parse(frame.line));
    const params = record(message?.params);
    const thread = string(params?.threadId);
    if (thread && message?.method === "turn/completed") {
      const turn = record(params?.turn);
      const id = string(turn?.id);
      if (id && turn?.status === "failed")
        remember(this.rawErrors, frameKey(thread, id), errorCode(turn.error));
      return;
    }
    const turn = string(params?.turnId);
    if (
      !thread ||
      !turn ||
      (message?.method !== "item/started" &&
        message?.method !== "item/completed")
    )
      return;
    const item = readItem(params?.item);
    if (
      !item ||
      item.type === "reasoning" ||
      item.type === "plan" ||
      item.type === "imageView" ||
      item.type === "imageGeneration"
    )
      return;
    const key = frameKey(thread, turn, item.id);
    remember(this.rawItems, key, {
      ...this.rawItems.get(key),
      [message.method === "item/started" ? "start" : "end"]: item,
    });
  }

  async publish(
    threadId: string,
    event: CanonicalEvent,
    sink: CodexPilotDisplaySink,
    model?: string,
  ): Promise<void> {
    if (event.kind === "context") {
      const data = record(event.body.data);
      const status = record(data?.status);
      const type = string(status?.type);
      if (type)
        await sink({
          type: "statusChanged",
          status: { type, activeFlags: strings(status?.activeFlags) },
        });
      const name = string(data?.name);
      if (name) await sink({ type: "threadNameUpdated", name });
    }
    const turnId = event.turn;
    if (!turnId) return;
    let turn = this.turns.get(turnId);
    if (!turn) {
      turn = { items: [] };
      this.turns.set(turnId, turn);
    }
    const itemKey = (id: string) => frameKey(threadId, turnId, id);
    switch (event.kind) {
      case "turn.started":
        await sink({
          type: "statusChanged",
          status: { type: "active" },
        });
        return;
      case "message.user":
        turn.items.push({
          type: "userMessage",
          id: String(event.seq),
          content: [],
        });
        return;
      case "message.assistant":
        turn.items.push({
          type: "agentMessage",
          id: event.body.message_id,
          text: event.body.text,
        });
        return;
      case "tool.call": {
        const item = this.rawItems.get(itemKey(event.body.call_id))?.start;
        const message = item && threadItemToMessage(item);
        if (message?.toolCalls?.length)
          await sink({ type: "itemStarted", message });
        return;
      }
      case "tool.result": {
        const key = itemKey(event.body.call_id);
        const item = this.rawItems.get(key)?.end;
        this.rawItems.delete(key);
        if (item) turn.items.push(item);
        return;
      }
      case "context": {
        const item = readItem(event.body.data);
        if (item) turn.items.push(item);
        return;
      }
      case "error": {
        if (event.body.class !== "codex-turn") return;
        const key = frameKey(threadId, turnId);
        const error = this.rawErrors.get(key);
        this.rawErrors.delete(key);
        turn.banner = codexTurnErrorMessage(
          turnId,
          { ...error, message: event.body.message },
          event.at,
          model,
        );
        await sink({ type: "error", message: event.body.message });
        return;
      }
      case "turn.ended": {
        this.turns.delete(turnId);
        const messages: ParsedMessage[] = threadItemsToMessages(turn.items).map(
          (message) => ({
            ...message,
            model,
          }),
        );
        if (turn.banner)
          messages.push({
            ...turn.banner,
            timestamp: Math.max(
              turn.banner.timestamp,
              (messages.at(-1)?.timestamp ?? 0) + 1,
            ),
          });
        await sink({
          type: "statusChanged",
          status: {
            type: event.body.reason === "completed" ? "idle" : "systemError",
          },
        });
        if (messages.length) await sink({ type: "messages", messages });
        return;
      }
    }
  }
}
