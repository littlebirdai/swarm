// When the voice speaks, over the lines of real huddles: `node turns.test.mjs`.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { registerHooks } from "node:module";
import { test } from "node:test";
import {
  forwardVoiceAsk,
  nameMatchers,
  turnIsForVoice,
  turnVerdict,
} from "./turns.mjs";

const named = nameMatchers(["Rufus", "Claude"]);
const room = { named, quiet: false, alone: false };

test("a room talking among itself never gets an answer", () => {
  // cl-158:545-570, after the voice had just spoken.
  for (const transcript of [
    "I can't hear you a shot.",
    "Can you hear me now?",
    "I was thinking about over the weekend how, like, it was almost better when we were just able to",
    "remember the deck from last week",
  ]) {
    assert.deepEqual(
      turnVerdict({ ...room, transcript }),
      { answer: false, quiet: false },
      transcript,
    );
  }
});

test("saying the name gets an answer, by either name, in any case", () => {
  for (const transcript of [
    "Hey Rufus, what did the session find?",
    "rufus",
    "claude can you check",
    "OK, RUFUS.",
  ]) {
    assert.equal(turnVerdict({ ...room, transcript }).answer, true, transcript);
  }
});

test("a name inside another word is not the name", () => {
  assert.equal(
    turnVerdict({ ...room, transcript: "Rufuses are dogs" }).answer,
    false,
  );
  assert.equal(
    turnVerdict({
      ...room,
      named: nameMatchers(["Ember"]),
      transcript: "remember that",
    }).answer,
    false,
  );
});

test("a quiet holds until the name comes back, even alone", () => {
  assert.deepEqual(
    turnVerdict({
      ...room,
      quiet: true,
      alone: true,
      transcript: "so what now",
    }),
    { answer: false, quiet: true },
  );
  assert.deepEqual(
    turnVerdict({ ...room, quiet: true, transcript: "Rufus, you there?" }),
    { answer: true, quiet: false },
  );
});

test("with one person in the call every line is for the voice", () => {
  assert.equal(
    turnVerdict({
      ...room,
      alone: true,
      transcript: "what does this function do",
    }).answer,
    true,
  );
  // Its turn ends before the words arrive, and the voice answers then.
  assert.equal(turnIsForVoice({ quiet: false, alone: true }), true);
  assert.equal(turnIsForVoice({ quiet: true, alone: true }), false);
  assert.equal(turnIsForVoice({ quiet: false, alone: false }), false);
});

test("an empty name list matches nothing", () => {
  assert.equal(
    turnVerdict({
      ...room,
      named: nameMatchers(["", " "]),
      transcript: "anything",
    }).answer,
    false,
  );
});

test("the tool call ID survives repeated execution and distinguishes identical asks", async () => {
  const ids = [];
  const execute = forwardVoiceAsk(
    async (ask) => ids.push(ask.client_id),
    () => "Ada",
  );
  const args = { request: "Inspect the cache" };
  await execute(args, { toolCallId: "ask-1" });
  await execute(args, { toolCallId: "ask-1" });
  await execute(args, { toolCallId: "ask-2" });
  assert.deepEqual(ids, ["ask-1", "ask-1", "ask-2"]);
});

test("the worker forwards one stable delivery ID per ask_agent tool call", async (t) => {
  const deps = {
    "@livekit/agents": `
      export const AutoSubscribe = { SUBSCRIBE_ALL: 1 };
      export const cli = { runApp() {} };
      export const defineAgent = (agent) => agent;
      export const llm = { tool: (tool) => tool };
      export class WorkerOptions {}
      export const voice = {
        AudioInput: class { multiStream = { addInputStream() {} }; },
        Agent: class { constructor({ tools }) { this.tools = tools; } },
        AgentSession: class {
          input = {};
          async start({ agent, room }) { room.tools = agent.tools; }
          on() {}
        },
        AgentSessionEventTypes: {},
      };
    `,
    "@livekit/rtc-node": `
      export class AudioMixer { *[Symbol.iterator]() {} }
      export class AudioStream {}
      export class VideoStream {}
      export const RoomEvent = new Proxy({}, { get: (_, name) => name });
      export const TrackKind = {};
      export const TrackSource = {};
    `,
    "@livekit/agents-plugin-openai":
      "export const realtime = { RealtimeModel: class {} };",
    "livekit-server-sdk":
      "export class AccessToken { addGrant() {} async toJwt() { return 'fixture'; } }",
  };
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      return Object.hasOwn(deps, specifier)
        ? {
            shortCircuit: true,
            url: `data:text/javascript,${encodeURIComponent(deps[specifier])}`,
          }
        : next(specifier, context);
    },
  });
  const { default: worker } = await import("./worker.mjs").finally(() =>
    hooks.deregister(),
  );
  const asks = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).startsWith("https://tavusapi.com/"))
      return Response.json({});
    if (body.op === "brief")
      return Response.json({ instructions: "Help the room", spoken_names: [] });
    assert.equal(body.op, "ask");
    asks.push(body);
    return Response.json({ ok: true });
  });
  const room = Object.assign(new EventEmitter(), {
    name: "test-room",
    localParticipant: { identity: "voice" },
    remoteParticipants: new Map([
      ["viewer", { identity: "viewer", trackPublications: new Map() }],
    ]),
  });
  const ready = Promise.withResolvers();
  room.on("newListener", (name) => {
    if (name === "Disconnected") ready.resolve();
  });
  const shutdowns = [];
  const running = worker.entry({
    room,
    job: {
      metadata: JSON.stringify({ conversation_id: "session", realtime: true }),
    },
    async connect() {},
    addShutdownCallback() {},
    shutdown(reason) {
      shutdowns.push(reason);
    },
  });
  try {
    await Promise.race([ready.promise, running]);
    for (const toolCallId of ["call-1", "call-1", "call-2"]) {
      await room.tools.ask_agent.execute(
        { request: "Check it" },
        { toolCallId },
      );
    }
    assert.deepEqual(
      asks.map(({ client_id, conversation_id, text }) => [
        client_id,
        conversation_id,
        text,
      ]),
      [
        ["call-1", "session", "Check it"],
        ["call-1", "session", "Check it"],
        ["call-2", "session", "Check it"],
      ],
    );
  } finally {
    room.emit("Disconnected");
    await running;
    assert.deepEqual(shutdowns, ["room closed"]);
  }
});
