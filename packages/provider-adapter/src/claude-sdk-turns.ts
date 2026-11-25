import type { SteerRequest } from "@codecast/provider-contract";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ContentBlock, type Frame } from "./claude-sdk-schema";
import { diagnostic, type DurablePayload } from "./provider-events";

const rememberedIds = 4_096;
const pendingSends = 128;

type Send = {
  request: SteerRequest;
  text: string;
  emitted?: true;
  terminal?: true;
};
type Projection = Effect.Effect<void>[];
type ScopedFrame = Extract<typeof Frame.Type, { session_id: string }>;

export function claudeTurns(
  run: number,
  checkpoint: string,
  durable: (
    payload: DurablePayload,
    turn: string | null,
  ) => Effect.Effect<void>,
  onEnd: () => void,
) {
  const sends = new Map<string, Send>();
  const seen = new Set<string>();
  let turnIndex = 0;
  let active:
    | { id: string; error?: { class: string; message: string } }
    | undefined;
  let reset = false;
  let resultEnded = false;
  const event = (payload: DurablePayload) =>
    durable(payload, active?.id ?? null);

  function remember(key: string) {
    if (seen.has(key)) return false;
    if (seen.size >= rememberedIds) {
      const oldest = seen.values().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
    seen.add(key);
    return true;
  }

  function begin(work: Projection) {
    if (active) return;
    resultEnded = false;
    active = { id: `claude-sdk:${run}:${++turnIndex}` };
    work.push(event({ kind: "turn.started", body: {} }));
  }

  function observedSend(uuid: string, work: Projection) {
    const send = sends.get(uuid);
    if (!send || send.emitted) return;
    send.emitted = true;
    work.push(
      event({
        kind: "message.user",
        body: {
          text: send.text,
          authors: [...send.request.authors],
          delivery_id: send.request.delivery_id,
        },
      }),
    );
  }

  function finish(reason: string, work: Projection) {
    if (!active) return;
    if (active.error) {
      work.push(
        event({
          kind: "error",
          body: {
            ...active.error,
            retryable: active.error.class === "rate_limit",
          },
        }),
      );
    }
    work.push(event({ kind: "turn.ended", body: { reason } }));
    active = undefined;
    onEnd();
  }

  const receive = Effect.fn("claude-sdk.turn-frame")(function* (
    frame: ScopedFrame,
    work: Projection,
  ) {
    if ("parent_tool_use_id" in frame && frame.parent_tool_use_id) return false;
    if (!remember(`frame:${frame.uuid}`)) return false;
    if (
      frame.session_id !== checkpoint &&
      reset &&
      (frame.type === "result" ||
        (frame.type === "system" && frame.subtype === "init"))
    ) {
      checkpoint = frame.session_id;
      reset = false;
      work.push(event({ kind: "context", body: { data: { checkpoint } } }));
    }
    if (frame.session_id !== checkpoint) return false;
    if (frame.type === "system") {
      if (frame.subtype === "init") {
        if (active)
          for (const id of frame.user_message_uuids ?? [])
            observedSend(id, work);
        if (frame.model || frame.permissionMode)
          work.push(
            event({
              kind: "context",
              body: {
                data: {
                  model: frame.model ?? null,
                  permission_mode: frame.permissionMode ?? null,
                },
              },
            }),
          );
      } else if (
        frame.state === "running" ||
        frame.state === "requires_action"
      ) {
        begin(work);
      } else {
        if (!resultEnded) {
          for (const id of sends.keys()) remember(`finished:${id}`);
          sends.clear();
          finish("no-result", work);
        }
        resultEnded = false;
        reset = false;
      }
    } else if (frame.type === "conversation_reset") {
      if (!active) return false;
      reset = true;
    } else if (frame.type === "command_lifecycle") {
      const id = frame.command_uuid;
      const send = sends.get(id);
      if (!send || send.terminal) return false;
      if (frame.state === "queued") resultEnded = false;
      if (frame.state === "started") {
        begin(work);
        observedSend(id, work);
      } else if (frame.state === "completed" || frame.state === "cancelled") {
        if (active) send.terminal = true;
        else {
          sends.delete(id);
          remember(`finished:${id}`);
        }
      }
    } else if (frame.type === "result") {
      if (!active) return false;
      const ids =
        frame.user_message_uuids ??
        (frame.user_message_uuid ? [frame.user_message_uuid] : []);
      if (ids.length && ids.every((id) => seen.has(`finished:${id}`)))
        return false;
      for (const id of ids) observedSend(id, work);
      for (const [id, send] of sends) {
        if (ids.includes(id) || send.terminal) {
          sends.delete(id);
          remember(`finished:${id}`);
        }
      }
      const interrupted = frame.terminal_reason === "aborted_streaming";
      if (interrupted || !frame.is_error) active.error = undefined;
      else
        active.error ??= {
          class: frame.subtype === "success" ? "claude-turn" : frame.subtype,
          message:
            diagnostic(frame.result) ||
            diagnostic(frame.errors?.join(" ")) ||
            "Claude turn failed",
        };
      finish(
        interrupted ? "interrupted" : frame.is_error ? "failed" : "completed",
        work,
      );
      reset = false;
      resultEnded = true;
    } else if (active) {
      const content = frame.message.content;
      const blocks =
        typeof content === "string"
          ? [{ type: "text", text: content } as const]
          : yield* Effect.forEach(content, (block) =>
              Effect.result(Schema.decodeUnknownEffect(ContentBlock)(block)),
            );
      const text: string[] = [];
      for (const entry of blocks) {
        if ("_tag" in entry && entry._tag === "Failure") continue;
        const block = "_tag" in entry ? entry.success : entry;
        if (block.type === "text") text.push(block.text);
        if (block.type === "tool_use" && remember(`tool:${block.id}`))
          work.push(
            event({
              kind: "tool.call",
              body: {
                call_id: block.id,
                name: block.name,
                input: block.input,
              },
            }),
          );
        if (
          block.type === "tool_result" &&
          remember(`tool-result:${block.tool_use_id}`)
        )
          work.push(
            event({
              kind: "tool.result",
              body: {
                call_id: block.tool_use_id,
                output: { inline: block.content ?? null },
                is_error: block.is_error ?? false,
              },
            }),
          );
      }
      if (frame.type === "assistant" && frame.error) {
        active.error ??= {
          class: frame.error,
          message: diagnostic(text.join("")) || frame.error,
        };
      } else if (frame.type === "assistant" && text.length) {
        work.push(
          event({
            kind: "message.assistant",
            body: { message_id: frame.uuid, text: text.join("") },
          }),
        );
      }
    } else return false;
    return true;
  });

  return {
    receive,
    finish,
    remember,
    active: () => active?.id ?? null,
    checkpoint: () => checkpoint,
    seenDelivery: (id: string) =>
      seen.has(`delivery:${id}`) ||
      [...sends.values()].some((send) => send.request.delivery_id === id),
    awaitingTurn: () =>
      (!active && sends.size > 0) || sends.size >= pendingSends,
    send(request: SteerRequest, text: string) {
      remember(`delivery:${request.delivery_id}`);
      const uuid = crypto.randomUUID();
      sends.set(uuid, { request, text });
      return uuid;
    },
  };
}
