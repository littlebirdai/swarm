import { expect } from "bun:test";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  FENCED_RUNTIME_CAPABILITIES,
  parseStartedDeliveryPermit,
  type ReadyBinding,
} from "@codecast/agent-clients/executionBinding";
import {
  createProviderAdapter,
  type ProviderOwnedSession,
} from "@codecast/provider-adapter";
import type { ProviderEvent } from "@codecast/provider-contract";
import { waitFor } from "@codecast/test-helpers/waitFor";
import {
  CodexAppServer,
  type ApprovalRequest,
} from "../../apps/cli/src/codex-app-server";
import { CodexAppServerRuntimeDriver } from "../../apps/cli/src/execution/drivers/codexAppServer";
import type { RuntimeStartRequest } from "../../apps/cli/src/execution/types";
import type { ParsedMessage } from "../../apps/cli/src/parser";
import { labelText, normalizeId } from "./recording";

type Frame = {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
};

export async function until(check: () => boolean, label: string) {
  expect(await waitFor(check, 3500, 5), label).toBe(true);
}

export function fake(directory: string, name: string) {
  const executable = join(directory, "codex");
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const args = [
    process.execPath,
    join(import.meta.dir, "fake-app-server.ts"),
    directory,
    name,
  ];
  writeFileSync(executable, `#!/bin/sh\nexec ${args.map(quote).join(" ")}\n`, {
    mode: 0o700,
  });
  const wirePath = join(directory, "wire");
  function wire(): Frame[] {
    return existsSync(wirePath)
      ? readFileSync(wirePath, "utf8")
          .split("\n")
          .slice(0, -1)
          .map((line) => JSON.parse(line))
      : [];
  }
  return {
    executable,
    wire,
    marked: (marker: string) => existsSync(join(directory, marker)),
    thread: `${name}-thread`,
    turn: (index: number) => `${name}-turn-${index}`,
    send(command: object) {
      const temporary = join(directory, "temporary");
      writeFileSync(temporary, JSON.stringify(command));
      renameSync(temporary, join(directory, "command"));
    },
  };
}

type Fake = ReturnType<typeof fake>;
export type Trace = {
  api: unknown[];
  events: string[];
  reasoning: string[];
  names: string[];
};

const version = "0.153.4";
const author = { kind: "person", id: "tester" } as const;
const options = { sandbox: "read-only", approvalPolicy: "on-request" } as const;
const fence = { run: 1, fencing_token: "parity-fence" };
const shortTurn = (id: string) => normalizeId(id);

function appendLegacy(
  { events, reasoning }: Trace,
  turn: string,
  messages: ParsedMessage[],
) {
  for (const message of messages) {
    expect(message.role).toBe("assistant");
    for (const call of message.toolCalls ?? []) {
      const input = call.input as { command: string };
      events.push(
        `${turn} call ${normalizeId(call.id)} ${call.name} ${labelText(input.command)}`,
      );
    }
    for (const result of message.toolResults ?? []) {
      events.push(
        `${turn} result ${normalizeId(result.toolUseId)} ${labelText(String(result.content))} ${result.isError ?? false}`,
      );
    }
    if (message.content)
      events.push(`${turn} assistant ${labelText(message.content)}`);
    if (message.thinking) {
      reasoning.push(message.thinking);
      events.push(`${turn} reasoning ${labelText(message.thinking)}`);
    }
  }
}

function appendAdapter(trace: Trace, event: ProviderEvent) {
  const { kind, body } = event;
  const turn = event.turn ? shortTurn(event.turn) : "session";
  switch (kind) {
    case "turn.started":
      trace.events.push(`${turn} started`);
      break;
    case "turn.ended":
    case "session.ended":
      trace.events.push(`${turn} ended ${body.reason}`);
      break;
    case "message.user":
      trace.events.push(
        `${turn} user ${labelText(body.text)} ${body.delivery_id ?? "unlinked"} ${body.authors.map(({ id }) => id).join(",") || "unattributed"}`,
      );
      break;
    case "message.assistant":
      trace.events.push(`${turn} assistant ${labelText(body.text)}`);
      break;
    case "message.delta":
      trace.events.push(
        `${turn} delta ${normalizeId(body.message_id)} ${body.offset} ${body.text}`,
      );
      break;
    case "tool.call":
      trace.events.push(
        `${turn} call ${normalizeId(body.call_id)} ${body.name} ${labelText(String((body.input as { command: string }).command))}`,
      );
      break;
    case "tool.result":
      trace.events.push(
        `${turn} result ${normalizeId(body.call_id)} ${labelText(String("inline" in body.output ? body.output.inline : body.output))} ${body.is_error}`,
      );
      break;
    case "prompt.opened":
      trace.events.push(
        `${turn} prompt ${body.prompt_id.split(":").at(-1)} ${body.kind}`,
      );
      break;
    case "prompt.settled":
      trace.events.push(
        `${turn} settled ${body.prompt_id.split(":").at(-1)} ${JSON.stringify(body.answer)} ${body.by.id}`,
      );
      break;
    case "context": {
      const data = body.data as {
        name?: string;
        type?: string;
        content?: string[];
        summary?: string[];
        questions?: { options: { label: string }[] }[];
      };
      if (data.name) trace.names.push(data.name);
      if (data.type === "reasoning") {
        const { content, summary } = data;
        expect(Array.isArray(content)).toBe(true);
        expect(Array.isArray(summary)).toBe(true);
        trace.reasoning.push(
          (content!.length ? content! : summary!).join("\n"),
        );
        trace.events.push(
          `${turn} reasoning content=${JSON.stringify(content!.map(labelText))} summary=${JSON.stringify(summary!.map(labelText))}`,
        );
      }
      if (data.questions)
        trace.events.push(
          `${turn} options ${data.questions.flatMap(({ options }) => options.map(({ label }) => label)).join(",")}`,
        );
      break;
    }
    default:
      trace.events.push(`${turn} ${kind}`);
  }
}

export function legacy(server: Fake, cwd: string, trace: Trace) {
  const client = new CodexAppServer({
    codexBinary: server.executable,
    log: () => {},
  });
  const prompts = new Map<string | number, ApprovalRequest>();
  const start: RuntimeStartRequest = {
    target: {
      conversationId: "session",
      epoch: 1,
      requestedAgent: "codex",
      transport: "app-server",
      projectPath: cwd,
      isolation: options,
    },
    configuration: { revision: 1 },
    ownerDeviceId: "machine",
    daemonBootId: "boot",
    requiredCapabilities: [...FENCED_RUNTIME_CAPABILITIES],
    protocolVersion: 1,
    trigger: "start-session",
    operationId: "start",
  };
  const driver = new CodexAppServerRuntimeDriver({
    io: {
      client,
      async inspectThread() {
        throw new Error("Resume must use thread/resume");
      },
      async stopThread() {
        throw new Error("Unexpected driver stop in replay");
      },
      async quarantineThread() {
        throw new Error("Unexpected driver quarantine in replay");
      },
    },
  });
  let binding: ReadyBinding;
  let exited = false;
  client.on("turnStarted", (_thread, turn: string) =>
    trace.events.push(`${shortTurn(turn)} started`),
  );
  client.on(
    "turnCompleted",
    (_thread, turn: string, messages: ParsedMessage[], status: string) => {
      appendLegacy(trace, shortTurn(turn), messages);
      trace.events.push(`${shortTurn(turn)} ended ${status}`);
    },
  );
  client.on(
    "messageDelta",
    (_thread, turn: string, text: string, id: string) => {
      trace.events.push(`${shortTurn(turn)} delta ${normalizeId(id)} ${text}`);
    },
  );
  client.on("approvalRequested", (_thread, prompt: ApprovalRequest) => {
    prompts.set(prompt.id, prompt);
    const turn = shortTurn(String(prompt.params.turnId));
    trace.events.push(
      `${turn} prompt ${prompt.id} ${prompt.method === "item/tool/requestUserInput" ? "question" : "permission"}`,
    );
    if (prompt.method === "item/tool/requestUserInput") {
      const questions = prompt.params.questions as {
        options: { label: string }[];
      }[];
      trace.events.push(
        `${turn} options ${questions.flatMap(({ options }) => options.map(({ label }) => label)).join(",")}`,
      );
    }
  });
  client.on("threadNameUpdated", (_thread, name: string) =>
    trace.names.push(name),
  );
  client.on("exited", (code) => {
    exited = true;
    trace.events.push(`process exited ${code}`);
  });
  client.on("error", (error: Error) =>
    trace.events.push(`client error ${error.message}`),
  );

  async function ready() {
    client.start();
    await until(() => client.running, "legacy initializes");
  }
  return {
    async start() {
      await ready();
      const started = await driver.start(start);
      if (started.state !== "started") throw new Error(JSON.stringify(started));
      binding = {
        ...started.handle,
        conversationId: "session",
        epoch: 1,
        requestedAgent: "codex",
        ownerDeviceId: "machine",
        daemonBootId: "boot",
        operationId: "start",
        appliedConfigurationRevision: 1,
        protocolVersion: 1,
        capabilities: [...started.handle.capabilities],
      };
      return ["opened", normalizeId(binding.handle)];
    },
    async steer(text: string, deliveryId: string, _turn: string | null) {
      const permit = parseStartedDeliveryPermit({
        state: "delivery-started",
        messageId: deliveryId,
        deliveryId,
        conversationSequence: "1",
        attemptId: deliveryId,
        conversationId: binding.conversationId,
        executionEpoch: binding.epoch,
        configurationRevision: 1,
        ownerDeviceId: binding.ownerDeviceId,
        daemonBootId: binding.daemonBootId,
        runtimeId: binding.runtimeId,
      });
      const result = await driver.deliver({
        binding,
        permit,
        delivery: {
          messageId: deliveryId,
          deliveryId,
          conversationSequence: "1",
          input: [{ type: "text", text }],
        },
      });
      return result.state;
    },
    async interrupt(turn: string) {
      await client.turnInterrupt(binding.handle, turn);
      return "applied";
    },
    async answer(
      id: string,
      answer:
        | { behavior: "allow" | "deny" }
        | { answers: { question: { answers: string[] } } },
    ) {
      await until(() => prompts.has(id), `legacy prompt ${id}`);
      const prompt = prompts.get(id)!;
      client.respondToApproval(
        id,
        "answers" in answer || answer.behavior === "allow",
        prompt.method,
        prompt.params,
      );
      return "sent";
    },
    pause() {
      return () => {};
    },
    async afterExit() {
      await until(() => exited, "legacy sees exit");
      client.stop();
    },
    async resume() {
      await ready();
      const { thread } = await client.threadResume({
        threadId: binding.handle,
        cwd,
        ...options,
      });
      return [
        "opened",
        normalizeId(thread.id),
        thread.turns?.map(({ id, status }) => [normalizeId(id), status]),
      ];
    },
    async close() {
      client.stop();
    },
  };
}

export function adapter(server: Fake, cwd: string, trace: Trace) {
  const raw: { line: string; disposition: string }[] = [];
  const client = createProviderAdapter({
    provider: { agent: "codex", version },
    command: [server.executable],
    retainRaw: (frame) => {
      raw.push(frame);
    },
  });
  const scope = { ...fence, session: "session", afterSeq: 10, cwd, options };
  let session: ProviderOwnedSession;
  let collecting: Promise<void> | undefined;
  let paused: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  let afterSeq = scope.afterSeq;
  let expected = fence;
  const prompts = new Map<string, string>();
  async function collect() {
    for await (const event of session.events) {
      if (event.kind !== "message.delta") {
        expect(event.seq).toBe(++afterSeq);
      }
      if (event.kind === "prompt.opened") {
        const id = event.body.prompt_id;
        prompts.set(id.split(":").at(-1)!, id);
      }
      appendAdapter(trace, event);
      if (paused) await paused.promise;
    }
  }
  function open(result: Awaited<ReturnType<typeof client.start>>) {
    if (result.status !== "opened") throw new Error(JSON.stringify(result));
    session = result.session;
    collecting = collect();
    return ["opened", normalizeId(session.getCheckpoint())];
  }
  return {
    raw,
    async start() {
      return open(await client.start(scope));
    },
    async steer(text: string, delivery_id: string, turn: string | null) {
      const result = await session.steer({
        expected: { ...expected, turn },
        input: [{ type: "text", text }],
        delivery_id,
        authors: [author],
      });
      return result.status === "in-doubt"
        ? `${result.status}/${result.reason}`
        : result.status;
    },
    async interrupt(turn: string) {
      return (await session.interrupt({ expected: { ...expected, turn } }))
        .status;
    },
    async answer(
      id: string,
      answer:
        | { behavior: "allow" | "deny" }
        | { answers: { question: { answers: string[] } } },
    ) {
      await until(() => prompts.has(id), `adapter prompt ${id}`);
      const result = await session.answer({
        expected: { ...expected, prompt_id: prompts.get(id)! },
        answer,
        by: author,
      });
      return result.status === "in-doubt"
        ? `${result.status}/${result.reason}`
        : result.status;
    },
    pause() {
      const gate = Promise.withResolvers<void>();
      paused = gate;
      return () => {
        paused = undefined;
        gate.resolve();
      };
    },
    async afterExit() {
      await collecting;
    },
    async resume() {
      const checkpoint = session.getCheckpoint();
      await session.close();
      expected = { ...fence, run: 2, fencing_token: "resume-fence" };
      return open(
        await client.resume({ ...scope, ...expected, afterSeq, checkpoint }),
      );
    },
    async close() {
      paused?.resolve();
      await client.dispose();
      await collecting;
    },
  };
}
