import { expect, test } from "bun:test";
import traces from "../../../tests/models/fixtures/delivery-traces.json";
import { modelOnlyActions } from "../../../tests/models/trace-cases";
import { sessionMachine, type SessionFact } from "../src/session-machine";
import { event, pending, request as firstRequest } from "./fixtures";

type State = (typeof traces)["own-retry"]["initial"];

for (const [name, trace] of Object.entries(traces)) {
  test(`Delivery/${name}`, () => {
    let reducer = pending;
    let id = firstRequest.delivery_id;
    let seq = firstRequest.seq;
    let factCount = 0;
    let outcome: "applied" | "duplicate" = "applied";

    function request() {
      const attempt = reducer.inbox
        .find((row) => row.delivery_id === id)
        ?.attempts.at(-1);
      return {
        ...firstRequest,
        run: reducer.run,
        fencing_token: reducer.lease?.fencing_token ?? "",
        delivery_id: id,
        attempt_id: attempt?.id ?? "",
        seq,
      };
    }

    function apply(fact: SessionFact) {
      const result = sessionMachine.apply(reducer, fact);
      factCount++;
      reducer = result.state;
      expect(result.effects).toEqual(
        fact.kind === "delivery.start"
          ? [
              {
                kind: "delivery.apply",
                request: fact.request,
                turn: null,
              },
            ]
          : [],
      );
    }

    const transitions = {
      Claim: () => {
        const row = reducer.inbox.find((entry) => entry.delivery_id === id)!;
        const attemptNumber = row.attemptNumber + 1;
        apply({
          ...request(),
          kind: "delivery.permitted",
          attempt_id: `${id}-${attemptNumber}`,
          attemptNumber,
        });
      },
      Start: () =>
        apply({ kind: "delivery.start", request: request(), turn: null }),
      Apply: (before: State, after: State) => {
        outcome = after.got === before.got ? "duplicate" : "applied";
      },
      Ack: () =>
        apply({ kind: "delivery.settle", request: { ...request(), outcome } }),
      DaemonRestarts: null,
      Requeue: () => apply({ ...request(), kind: "delivery.returned" }),
      ReportAmbiguous: () =>
        apply({
          kind: "delivery.settle",
          request: { ...request(), outcome: "in_doubt" },
        }),
      HostDies: () =>
        apply({ ...request(), kind: "run.processExited", pid: 1, exitCode: 1 }),
      Reopen: (_before: State, after: State) => {
        apply({
          ...request(),
          kind: "run.successorAuthorized",
          successor: after.epoch,
        });
        const fence = {
          session: reducer.session,
          run: after.epoch,
          fencing_token: `epoch-${after.epoch}`,
        };
        apply({
          ...fence,
          kind: "run.claimed",
          claimNumber: 1,
          expires_at: 10,
        });
        apply({ ...fence, kind: "run.runtimeReady" });
      },
      Supersede: (before: State, after: State) => {
        if (before.st !== "started" || after.st === "ambiguous") return;
        apply({
          ...request(),
          kind: "delivery.reconciled",
          applied: before.rc,
          evidence: before.rc
            ? "receipt from successor host"
            : "receipt scan from successor host",
        });
      },
      Correlate: () =>
        apply(
          event(
            reducer.eventSeq + 1,
            null,
            {
              kind: "receipt",
              body: { delivery_id: id },
            },
            { session: reducer.session, run: reducer.run },
          ),
        ),
      SendAgain: () => {
        const replacement = `${id}-resend`;
        apply({
          ...request(),
          kind: "inbox.abandoned",
          resend: {
            delivery_id: replacement,
            seq: seq + 1,
            intent: firstRequest.intent,
            expectedTurn: null,
          },
        });
        expect(
          reducer.inbox.find((row) => row.delivery_id === id)?.status,
        ).toBe("abandoned-ambiguous");
        id = replacement;
        seq++;
      },
      Done: null,
      Parked: null,
    };

    function compare(model: State, action: string) {
      const status = {
        waiting: "pending",
        claimed: "claimed",
        started: "delivery-started",
        delivered: "delivered",
        ambiguous: "ambiguous",
      } as const;
      let expected = status[model.st as keyof typeof status];
      if (model.pEpoch !== 0 && model.pEpoch < model.epoch) {
        expected = model.st === "claimed" ? "pending" : "ambiguous";
      }

      const row = reducer.inbox.find((entry) => entry.delivery_id === id);
      if (
        action === "Correlate" ||
        (action === "Supersede" && model.st === "delivered")
      ) {
        expect(row?.status, action).toBe("correlated-delivered");
      }
      const observed =
        row?.status === "correlated-delivered" ? "delivered" : row?.status;
      expect(observed, action).toBe(expected);
      const permit =
        row?.status === "claimed" || row?.status === "delivery-started"
          ? row.attempts.at(-1)?.run
          : 0;
      expect(permit, action).toBe(
        model.pEpoch === model.epoch ? model.pEpoch : 0,
      );
      expect(reducer.run, action).toBe(model.epoch);
      expect(reducer.runStatus, action).toBe(
        model.host === 0 ? "stopped" : "ready",
      );
    }

    compare(trace.initial, "Init");
    let before = trace.initial;
    for (const { action, state } of trace.steps) {
      expect(Object.hasOwn(transitions, action)).toBe(true);
      const previousFactCount = factCount;
      const shouldDriveCode =
        !modelOnlyActions.Delivery.includes(action) &&
        (action !== "Supersede" ||
          (before.st === "started" && state.st !== "ambiguous"));
      transitions[action as keyof typeof transitions]?.(before, state);
      expect(factCount > previousFactCount, action).toBe(shouldDriveCode);
      compare(state, action);
      before = state;
    }
  });
}
