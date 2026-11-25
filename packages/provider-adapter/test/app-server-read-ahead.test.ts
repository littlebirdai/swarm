import { readEvent, requireOpened } from "./provider-fixture";
import { appServerCase } from "./app-server-fixture";
import { expect, spyOn } from "bun:test";
import { it } from "@codecast/effect-kit/effect/testing";
import type { ProviderOwnedSession } from "../src";
import { waitFor } from "@codecast/test-helpers/waitFor";
import * as Effect from "effect/Effect";
import {
  answer,
  approval,
  bestEffort,
  fixture,
  installAppServerFixtureHooks,
  interrupt,
  scope,
  steer,
  threadId,
  turn,
} from "./app-server-fixture";

installAppServerFixtureHooks();

async function settled<A>(pending: Promise<A>) {
  let done = false;
  void pending.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  expect(await waitFor(() => done, 1500, 5)).toBe(true);
  return pending;
}

type Fixture = ReturnType<typeof fixture>;
async function fill(fake: Fixture) {
  await fake.wrote({ fill: true }, false);
  await settled(fake.full);
}

for (const [label, command, code] of [
  ["EOF", { closeStdout: true }, "channel-ended"],
  ["stdout failure", { stderr: "fixture stdout fault" }, "read-failed"],
  ["stderr failure", { stderr: "fixture stderr fault" }, "stderr-handler"],
  ["overflow", { largeFrames: 6 }, "output-overflow"],
] as const) {
  appServerCase(
    `${label} settles every pending control while events are paused`,
    async (session, fake) => {
      expect(await session.steer(steer)).toEqual(bestEffort);
      const events = session.events[Symbol.asyncIterator]();
      expect((await events.next()).value?.kind).toBe("turn.started");
      await fill(fake);
      const request = { ...steer, expected: { ...steer.expected, turn } };
      const calls = [session.steer(request), session.steer(request)];
      expect(await waitFor(() => fake.observed().length === 3, 1500, 5)).toBe(
        true,
      );
      await fake.wrote(command, false);
      expect(await settled(Promise.all(calls))).toEqual([
        expect.objectContaining({ status: "in-doubt", code }),
        expect.objectContaining({ status: "in-doubt", code }),
      ]);
      expect(await settled(session.interrupt(interrupt))).toEqual({
        status: "closed",
      });
      expect(await settled(session.steer(request))).toEqual({
        status: "closed",
      });
      expect(await settled(session.answer(answer))).toEqual({
        status: "closed",
      });
      expect(fake.observed()).toHaveLength(3);
    },
    {
      FIXTURE_HOLD_ALL_STEERS: "1",
      FIXTURE_READ_FAILURE: label === "stdout failure" ? "1" : "",
      FIXTURE_CLOSE_STDOUT: label === "EOF" ? "1" : "",
    },
  );
}

appServerCase(
  "terminal start reply events wait for a paused consumer",
  async (session, fake) => {
    await fill(fake);
    for (let index = 0; index < 26; index++)
      expect(await settled(session.steer(steer))).toEqual(bestEffort);
    const events = session.events[Symbol.asyncIterator]();
    for (let index = 0; index <= 32; index++)
      expect((await events.next()).value).toMatchObject({
        kind: "context",
        body: { data: { name: String(index) } },
      });
    for (let index = 1; index <= 26; index++) {
      expect((await events.next()).value).toMatchObject({
        kind: "turn.started",
        turn: `actual-turn-${index}`,
      });
      expect((await events.next()).value).toMatchObject({
        kind: "turn.ended",
        turn: `actual-turn-${index}`,
      });
    }
  },
  {
    FIXTURE_REPLY_ONLY: "1",
    FIXTURE_TERMINAL_START: "1",
  },
);

appServerCase(
  "a refused turn start permits immediate retry while events are paused",
  async (session, fake) => {
    await fill(fake);
    const first = session.steer(steer);
    expect(await waitFor(() => fake.observed().length === 1, 1500, 5)).toBe(
      true,
    );
    await fake.wrote({ rejectStart: true }, false);
    expect(await settled(first)).toMatchObject({
      status: "refused",
      code: "rpc-rejected",
    });
    const retry = session.steer(steer);
    expect(await waitFor(() => fake.observed().length === 2, 1500, 5)).toBe(
      true,
    );
    await fake.wrote({ ackStart: true }, false);
    expect(await settled(retry)).toEqual(bestEffort);
  },
  { FIXTURE_HOLD_START: "1" },
);

appServerCase(
  "a control sent after the event buffer is full settles without a reader",
  async (session, fake) => {
    expect(await session.steer(steer)).toEqual(bestEffort);
    const events = session.events[Symbol.asyncIterator]();
    expect((await events.next()).value?.kind).toBe("turn.started");
    await fill(fake);
    expect(await settled(session.interrupt(interrupt))).toEqual({
      status: "applied",
    });
  },
);

it.effect(
  "a duplicate RPC response is unknown and keeps echoed attribution",
  () =>
    Effect.promise(async () => {
      const fake = fixture();
      const holding = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const retain = fake.options.retainRaw;
      spyOn(fake.options, "retainRaw").mockImplementation((frame) => {
        retain(frame);
        if (frame.line.includes('"threadName":"paused retention"')) {
          holding.resolve();
          return release.promise;
        }
      });
      const { session } = requireOpened(await fake.client.start(fake.spec));
      try {
        expect(await session.steer(steer)).toEqual(bestEffort);
        const next = readEvent(session);
        expect((await next())?.kind).toBe("turn.started");
        await fake.wrote(
          {
            frame: {
              method: "thread/name/updated",
              params: { threadId, threadName: "paused retention" },
            },
          },
          false,
        );
        await settled(holding.promise);
        const request = {
          ...steer,
          expected: { ...steer.expected, turn },
          delivery_id: "steered",
          authors: [{ kind: "person" as const, id: "sender" }],
          input: [{ type: "text" as const, text: "match this steer" }],
        };
        expect(await settled(session.steer(request))).toEqual(bestEffort);
        await fake.wrote(
          {
            frame: {
              id: fake.observed().at(-1)?.message.id,
              error: { code: -32000, message: "duplicate reply" },
            },
          },
          false,
        );
        await fake.wrote(
          {
            frame: {
              method: "item/completed",
              params: {
                threadId,
                turnId: turn,
                item: {
                  type: "userMessage",
                  id: "echo",
                  content: request.input,
                },
              },
            },
          },
          false,
        );

        release.resolve();
        expect(await next()).toMatchObject({
          kind: "context",
          body: { data: { name: "paused retention" } },
        });
        expect(await next()).toMatchObject({
          kind: "message.user",
          body: { delivery_id: request.delivery_id, authors: request.authors },
        });
        expect(
          fake.raw.find(({ line }) => line.includes("duplicate reply"))
            ?.disposition,
        ).toBe("unknown");
      } finally {
        release.resolve();
        await session.close();
      }
    }),
);

appServerCase(
  "read-ahead is capped by bytes even below the frame limit",
  async (session, fake) => {
    await fill(fake);
    expect(await settled(session.steer(steer))).toMatchObject({
      status: "in-doubt",
      code: "output-overflow",
    });
  },
  { FIXTURE_LARGE_START: "1" },
);

it.effect("draining releases read-ahead bytes across more than 32 MiB", () =>
  Effect.promise(async () => {
    const fake = fixture();
    const { session }: { session: ProviderOwnedSession } = requireOpened(
      await fake.client.start(fake.spec),
    );
    try {
      const events = session.events[Symbol.asyncIterator]();
      for (let index = 0; index < 6; index++) {
        await fake.wrote({ largeFrames: 1 }, false);
        const event = (await events.next()).value;
        expect(event?.kind).toBe("context");
        const data = event?.kind === "context" ? event.body.data : null;
        expect((data as { name: string }).name.length).toBe(6 * 1024 * 1024);
      }
      expect(await settled(session.steer(steer))).toEqual(bestEffort);
    } finally {
      await session.close();
    }
  }),
);

it.effect("EOF settles an approval queued behind a blocked stdin write", () =>
  Effect.promise(async () => {
    const fake = fixture({ FIXTURE_CLOSE_STDOUT: "1" });
    const { session } = requireOpened(await fake.contract.open(scope));
    try {
      expect(await session.steer(steer)).toEqual(bestEffort);
      await fake.wrote({ frame: approval() });
      const next = readEvent(session);
      expect((await next())?.kind).toBe("turn.started");
      expect((await next())?.kind).toBe("prompt.opened");
      const gate = fake.contract.pauseBeforeWrite?.();
      if (!gate) throw new Error("Expected a fixture write gate");
      try {
        const pending = session.answer(answer);
        await settled(gate.entered);
        await fill(fake);
        await fake.wrote({ closeStdout: true }, false);
        expect(await settled(pending)).toMatchObject({
          status: "in-doubt",
          code: "channel-ended",
        });
      } finally {
        gate.release();
      }
      expect(await session.answer(answer)).toEqual({ status: "closed" });
      expect(fake.observed().map(({ action }) => action)).toEqual(["steer"]);
    } finally {
      await session.close();
    }
  }),
);
