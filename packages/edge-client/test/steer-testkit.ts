import { expect } from "bun:test";
import {
  EXPECTED_CAPABILITY,
  STEER_BATON_CAPABILITY,
  TAKEOVER_FENCE_CAPABILITY,
  type PermitsNextRequest,
  type TakeoverFence,
} from "@codecast/edge-contract";
import * as Effect from "effect/Effect";
import hello from "../../edge-contract/test/fixtures/hello.json";
import { EdgeClient } from "../src/effect";
import type {
  EdgeSteerJournal,
  EdgeSteerPermit,
  EdgeSteeringHost,
} from "../src";
import { reply, scriptedTransport, type Step } from "./scripted-transport";

export const run = {
  v: 1,
  session: "session",
  run: 1,
  fencing_token: "lease",
} satisfies PermitsNextRequest;
export const startRequest = {
  ...run,
  delivery_id: "send",
  attempt_id: "attempt",
  seq: 2,
  intent: "steer" as const,
  sender: { kind: "person" as const, id: "ana" },
};
export const steer: EdgeSteerPermit = {
  ...startRequest,
  status: "permit",
  state: "new",
  input: [{ type: "text", text: "hello" }],
  expected: { kind: "turn", turn: "turn" },
  baton_token: null,
};
export const fence = {
  ...run,
  status: "takeover_fence",
  turn: "turn",
  fence_id: "fence",
  baton_token: null,
  new_baton_token: 1,
} satisfies TakeoverFence;
const capabilities = [
  EXPECTED_CAPABILITY,
  STEER_BATON_CAPABILITY,
  TAKEOVER_FENCE_CAPABILITY,
];
export const helloReply = {
  ...hello.response,
  policy: { ...hello.response.policy, capabilities },
};
export const recorded = { v: 1, status: "recorded" } as const;
export const started = { ...startRequest, status: "started" };

export function machine() {
  let currentTurn: string | null = "turn";
  let durable: EdgeSteerJournal | undefined;
  const handed: string[] = [];
  const prepared: string[] = [];
  const host: EdgeSteeringHost = {
    runningTurn: () => currentTurn,
    prepare: async (permit) => {
      prepared.push(permit.attempt_id);
      return async () => {
        expect(
          durable?.handovers.some(
            (item) => item.attempt_id === permit.attempt_id,
          ),
        ).toBe(true);
        handed.push(permit.attempt_id);
        return { outcome: "applied" };
      };
    },
    recover: async () => ({ outcome: "in_doubt" }),
    journal: {
      load: async () => structuredClone(durable),
      save: async (_, journal) => {
        durable = structuredClone(journal);
      },
    },
  };
  const turn = (id: string | null) => {
    currentTurn = id;
  };
  return {
    host,
    turn,
    handed,
    prepared,
    journal: () => structuredClone(durable),
  };
}

export function connected(
  host: EdgeSteeringHost,
  steps: Step[],
  body: (
    client: EdgeClient["Service"],
    calls: ReturnType<typeof scriptedTransport>["calls"],
  ) => Effect.Effect<void, unknown>,
  policy = helloReply,
) {
  const { calls, transport } = scriptedTransport(reply(policy), ...steps);
  return Effect.gen(function* () {
    const client = yield* EdgeClient;
    yield* client.hello({ ...hello.request, capabilities: ["heartbeat"] });
    expect(calls[0]?.request).toMatchObject({
      capabilities: ["heartbeat", ...capabilities],
    });
    yield* body(client, calls);
  }).pipe(Effect.provide(EdgeClient.layer({ transport, steering: host })));
}
