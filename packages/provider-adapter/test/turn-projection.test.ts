import { describe, expect } from "bun:test";
import { it } from "@codecast/effect-kit/effect/testing";
import * as Effect from "effect/Effect";
import {
  parseCanonicalEvent,
  type CanonicalEvent,
} from "@codecast/edge-contract";
import type { ProviderEventIterator } from "@codecast/provider-contract";
import * as acp from "./acp-fixture";
import * as appServer from "./app-server-fixture";
import claude from "./fixtures/claude-tool-allow.json";
import {
  projectTurn,
  type TurnProjection,
} from "../../session-contract/src/turn-projection";

function initial(scope: {
  session: string;
  run: number;
  afterSeq: number;
}): TurnProjection {
  return {
    session: scope.session,
    run: scope.run,
    eventSeq: scope.afterSeq,
    status: "active",
    turnIds: [],
    openTurn: null,
  };
}

async function readTurn(iterator: ProviderEventIterator) {
  const events: CanonicalEvent[] = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done)
      throw new Error("Provider stopped before the end of the turn");
    if (next.value.kind === "message.delta") continue;
    const parsed = parseCanonicalEvent(next.value);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
    events.push(parsed.value);
    if (parsed.value.kind === "turn.ended") return events;
  }
}

describe("recorded Grok ACP turn", () => {
  acp.installAcpFixtureHooks();

  it.effect("opens the named turn and closes on end_turn", () =>
    Effect.promise(async () => {
      const fake = acp.fixture();
      const opened = await fake.client.resume({
        ...fake.spec,
        checkpoint: "resumed",
      });
      if (opened.status !== "opened") throw new Error(JSON.stringify(opened));
      const { session } = opened;
      try {
        expect(await session.steer(acp.steer)).toEqual(acp.bestEffort);
        for (const frame of acp.recorded.slice(1, 13)) {
          await fake.wrote({
            frame: {
              ...frame,
              params: { ...frame.params, sessionId: "resumed" },
            },
          });
        }
        await fake.wrote({ complete: true });
        const events = await readTurn(session.events[Symbol.asyncIterator]());
        const start = initial(acp.scope);
        expect(projectTurn(start, events.slice(0, 2)).openTurn).toEqual({
          id: "1:1",

          promptIds: [],
        });
        expect(events.at(-1)).toMatchObject({
          turn: "1:1",
          body: { reason: "end_turn" },
        });
        expect(projectTurn(start, events)).toMatchObject({
          openTurn: null,
          turnIds: ["1:1"],
          eventSeq: acp.scope.afterSeq + events.length,
        });
      } finally {
        await session.close();
      }
    }),
  );
});

describe("recorded Codex app-server turn", () => {
  appServer.installAppServerFixtureHooks();

  it.effect("opens the named turn and closes on turn/completed", () =>
    Effect.promise(async () => {
      const fake = appServer.fixture({ FIXTURE_HOLD_SECOND: "1" });
      const { session } = appServer.requireOpened(
        await fake.client.start(fake.spec),
      );
      try {
        expect(await session.steer(appServer.steer)).toEqual(
          appServer.bestEffort,
        );
        for (const type of [
          "userMessage",
          "commandExecution",
          "agentMessage",
        ]) {
          const event = appServer.recorded.find(
            (entry) =>
              entry.method === "item/completed" &&
              entry.params.item?.type === type,
          );
          if (!event) throw new Error(`Missing recorded ${type}`);
          await fake.wrote({
            frame: {
              ...event,
              params: {
                ...event.params,
                threadId: appServer.threadId,
                turnId: appServer.turn,
              },
            },
          });
        }
        const completion = appServer.recorded.find(
          (entry) => entry.method === "turn/completed",
        );
        if (!completion) throw new Error("Missing recorded completion");
        await fake.wrote({
          frame: {
            ...completion,
            params: {
              threadId: appServer.threadId,
              turn: {
                ...(completion.params.turn as object),
                id: appServer.turn,
              },
            },
          },
        });
        const events = await readTurn(session.events[Symbol.asyncIterator]());
        const start = initial(appServer.scope);
        expect(projectTurn(start, events.slice(0, -1)).openTurn).toEqual({
          id: appServer.turn,

          promptIds: [],
        });
        expect(events.at(-1)).toMatchObject({
          turn: appServer.turn,
          body: { reason: "completed" },
        });
        expect(projectTurn(start, events)).toMatchObject({
          openTurn: null,
          turnIds: [appServer.turn],
          eventSeq: appServer.scope.afterSeq + events.length,
        });
      } finally {
        await session.close();
      }
    }),
  );
});

it.effect(
  "the Claude SDK tool-allow recording opens and settles the named prompt before the turn ends",
  () =>
    Effect.sync(() => {
      const events = claude.map((frame) => {
        const parsed = parseCanonicalEvent(frame);
        if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
        return parsed.value;
      });
      const start = initial({
        session: "claude-fixture",
        run: 1,
        afterSeq: 10,
      });
      const turn = {
        id: "claude-sdk:1:1",

        promptIds: [],
      } satisfies NonNullable<TurnProjection["openTurn"]>;
      const blocked = projectTurn(start, events.slice(0, 5));
      expect(blocked.openTurn).toEqual({
        ...turn,
        promptIds: ["1:claude-sdk:d75483ad-710c-4b9f-8bd1-d02cabb7bf8f"],
      });
      const settled = projectTurn(blocked, events.slice(5, -1));
      expect(settled.openTurn).toEqual(turn);
      expect(projectTurn(settled, events.slice(-1))).toMatchObject({
        openTurn: null,
        turnIds: [turn.id],
        eventSeq: 19,
      });
    }),
);
