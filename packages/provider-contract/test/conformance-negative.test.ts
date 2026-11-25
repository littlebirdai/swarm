import { expect, test } from "bun:test";
import type { ObservedSession, OwnedSession, ProviderEvent } from "../src";
import { providerConformanceCases, type ProviderFixture } from "./conformance";
import { fakeProvider } from "./fake-provider";

type Session = ObservedSession | OwnedSession;
type CaseName = keyof ReturnType<typeof providerConformanceCases>;

const provider = {
  agent: "fixture",
  version: "1",
  capabilities: [
    "own",
    "receipts",
    "steer-mid-turn",
    "interrupt",
    "prompts",
    "resume",
  ],
} as const;

function withSession(
  fixture: ProviderFixture,
  alter: (session: Session) => void,
): ProviderFixture {
  const open = fixture.open;
  return {
    ...fixture,
    async open(scope) {
      const result = await open(scope);
      if (result.status === "opened") alter(result.session);
      return result;
    },
  };
}

async function rejectsBrokenFixture(fixture: ProviderFixture, name: CaseName) {
  const verdict = await providerConformanceCases(() => fixture)
    [name]()
    .then(
      () => "accepted",
      () => "rejected",
    );
  expect(verdict).toBe("rejected");
}

for (const field of ["run", "fencing_token"] as const) {
  test(`kit rejects interrupt that ignores ${field}`, async () => {
    const fixture = fakeProvider(provider);
    await rejectsBrokenFixture(
      withSession(fixture, (session) => {
        const interrupt = session.interrupt;
        session.interrupt = (request) =>
          interrupt({
            expected: {
              ...request.expected,
              [field]: fixture.interrupt.expected[field],
            },
          });
      }),
      "stale actions reach neither the agent nor the pane or leak a fence",
    );
  });

  test(`kit rejects answer that ignores ${field}`, async () => {
    const fixture = fakeProvider(provider);
    await rejectsBrokenFixture(
      withSession(fixture, (session) => {
        const answer = session.answer;
        session.answer = (request) =>
          answer({
            ...request,
            expected: {
              ...request.expected,
              [field]: fixture.answer.expected[field],
            },
          });
      }),
      "stale actions reach neither the agent nor the pane or leak a fence",
    );
  });
}

for (const control of ["interrupt", "answer"] as const) {
  test(`kit rejects ${control} after close`, async () => {
    const fixture = fakeProvider(provider);
    const leaked: string[] = [];
    await rejectsBrokenFixture(
      withSession(
        { ...fixture, effects: () => [...fixture.effects(), ...leaked] },
        (session) => {
          const close = session.close;
          session.close = async () => {
            const result = await close();
            session[control] = async () => {
              leaked.push(control);
              return { status: "closed" };
            };
            return result;
          };
        },
      ),
      "close releases once and denies every action and late event",
    );
  });
}

test("kit rejects a fencing token in a stale observation", async () => {
  const fixture = fakeProvider(provider);
  await rejectsBrokenFixture(
    withSession(fixture, (session) => {
      const steer = session.steer;
      session.steer = async (request) => {
        const outcome = await steer(request);
        if (outcome.status !== "stale") return outcome;
        const observed = {
          ...outcome.observed,
          fencing_token: request.expected.fencing_token,
        };
        return { ...outcome, observed };
      };
    }),
    "stale actions reach neither the agent nor the pane or leak a fence",
  );
});

for (const failure of ["throw", "no effect"] as const) {
  function maybeThrow() {
    if (failure === "throw") throw new Error("Advertised operation failed");
  }

  test(`kit rejects advertised steer-mid-turn with ${failure}`, async () => {
    const fixture = fakeProvider(provider);
    await rejectsBrokenFixture(
      withSession(fixture, (session) => {
        session.steer = async (request) => {
          maybeThrow();
          return {
            status: "accepted",
            receipt: { delivery_id: request.delivery_id },
          };
        };
      }),
      "advertised controls apply in the active turn",
    );
  });

  for (const control of ["interrupt", "answer"] as const) {
    test(`kit rejects advertised ${control} with ${failure}`, async () => {
      const fixture = fakeProvider(provider);
      await rejectsBrokenFixture(
        withSession(fixture, (session) => {
          session[control] = async () => {
            maybeThrow();
            return { status: "applied" };
          };
        }),
        "advertised controls apply in the active turn",
      );
    });
  }

  test(`kit rejects advertised resume with ${failure}`, async () => {
    let previous: OwnedSession | undefined;
    const fixture = withSession(fakeProvider(provider), (session) => {
      if (session.mode === "own") previous = session;
    });
    await rejectsBrokenFixture(
      {
        ...fixture,
        adapter: {
          ...fixture.adapter,
          async resume() {
            maybeThrow();
            if (!previous) throw new Error("Expected an earlier owned session");
            return { status: "opened", session: previous };
          },
        },
      },
      "resume opens the current checkpoint and recovers durable receipts when offered",
    );
  });
}

test("kit rejects duplicate before validating a stale fence", async () => {
  const fixture = fakeProvider(provider);
  await rejectsBrokenFixture(
    withSession(fixture, (session) => {
      const steer = session.steer;
      session.steer = (request) =>
        steer({
          ...request,
          expected: {
            ...request.expected,
            fencing_token: fixture.steer.expected.fencing_token,
          },
        });
    }),
    "receipts are emitted at most once and require a valid fence",
  );
});

for (const [name, corrupt] of [
  ["wrong session", (event: ProviderEvent) => ({ ...event, session: "wrong" })],
  ["wrong run", (event: ProviderEvent) => ({ ...event, run: event.run + 1 })],
  [
    "malformed canonical payload",
    (event: ProviderEvent) => ({ ...event, at: -1 }),
  ],
  ["sequence at cursor", (event: ProviderEvent) => ({ ...event, seq: 10 })],
  ["repeated sequence", (event: ProviderEvent) => ({ ...event, seq: 11 })],
] as const) {
  test(`kit rejects an event with ${name}`, async () => {
    const fixture = fakeProvider(provider);
    await rejectsBrokenFixture(
      withSession(fixture, (session) => {
        const stream = session.events;
        const iterator = stream[Symbol.asyncIterator]();
        const next = iterator.next.bind(iterator);
        iterator.next = async () => {
          const result = await next();
          return result.done
            ? result
            : { done: false, value: corrupt(result.value) };
        };
      }),
      "events are canonical, scoped and ordered",
    );
  });
}
