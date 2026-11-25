import { expect, test } from "bun:test";
import {
  classifyWorkState,
  type WorkStateInput,
} from "@codecast/inbox/inboxProjection";
import {
  sessionMachine,
  type SessionState,
  type SessionVisibility,
} from "@codecast/session-contract";
import { testFaker } from "@codecast/test-helpers/faker";
import {
  ambiguous,
  applyFacts,
  blocked,
  claimed,
  empty,
  ended,
  fence,
  pending,
  permitted,
  ready,
  running,
  sending,
  submit,
} from "./fixtures";

type Pin = Parameters<typeof sessionMachine.whoActsNext>[1];
type Case = readonly [
  string,
  SessionState,
  Pin,
  SessionVisibility,
  Partial<WorkStateInput>,
];
const endedTurn = applyFacts(running, ended);
const stopped = applyFacts(running, {
  ...fence,
  kind: "run.processExited",
  pid: 1,
  exitCode: 1,
});
const stoppedWithPending = applyFacts(ready, submit, {
  ...fence,
  kind: "run.quarantineConfirmed",
});
const expired = applyFacts(endedTurn, {
  ...fence,
  kind: "run.leaseExpired",
  expires_at: 10,
});
const faulted = applyFacts(claimed, {
  ...fence,
  kind: "run.launchFailed",
  retryable: true,
});
const uncertain = applyFacts(claimed, {
  ...fence,
  kind: "run.inspectionUnknown",
});
const held = applyFacts(ready, { ...submit, held: true });

const cases: readonly Case[] = [
  ["blank", empty, null, {}, { messageCount: 0 }],
  [
    "retired",
    sending,
    "blocked",
    { killed: true },
    { killed: true, agentStatus: "working" },
  ],
  ["starting", claimed, "blocked", {}, { agentStatus: "starting" }],
  [
    "running before blocked pin",
    running,
    "blocked",
    {},
    { agentStatus: "working" },
  ],
  [
    "blocked live turn",
    blocked,
    "done",
    {},
    { agentStatus: "permission_blocked", awaitingInput: true },
  ],
  [
    "started delivery before blocked pin",
    sending,
    "blocked",
    {},
    { agentStatus: "working" },
  ],
  [
    "ambiguous delivery before dormant pin",
    ambiguous,
    "dormant",
    {},
    { isUnresponsive: true },
  ],
  ["uncertain startup", uncertain, "dormant", {}, { isUnresponsive: true }],
  ["failed startup", faulted, "dormant", {}, { isUnresponsive: true }],
  ["expired run", expired, "dormant", {}, { isUnresponsive: true }],
  ["stopped with activity", stopped, "dormant", {}, { agentStatus: "stopped" }],
  [
    "stopped after done",
    stopped,
    "done",
    {},
    { agentStatus: "stopped", declaredStatus: "done" },
  ],
  [
    "quarantined with pending input",
    stoppedWithPending,
    "done",
    {},
    { agentStatus: "stopped", declaredStatus: "done", hasPending: true },
  ],
  [
    "deliverable pending before blocked pin",
    pending,
    "blocked",
    {},
    { hasPending: true },
  ],
  ["claimed input", permitted, "dormant", {}, { hasPending: true }],
  ["held input stays idle", held, null, {}, { messageCount: 0 }],
  ["blocked pin", endedTurn, "blocked", {}, { declaredStatus: "blocked" }],
  ["dormant pin", endedTurn, "dormant", {}, { agentStatus: "dormant" }],
  ["done pin", endedTurn, "done", {}, { declaredStatus: "done" }],
  ["ended without a verdict", endedTurn, null, {}, {}],
  [
    "stale working pin",
    endedTurn,
    "working",
    {},
    { declaredStatus: "working" },
  ],
  [
    "API-error park",
    endedTurn,
    "done",
    { pendingApiError: true },
    { pendingApiError: true },
  ],
  [
    "hibernation uses the pin",
    stopped,
    "dormant",
    { parked: true },
    { agentStatus: "hibernated", armedLoopHome: true },
  ],
  [
    "hosted work queued",
    empty,
    null,
    { hostedQueued: true },
    { hasPending: true, messageCount: 0 },
  ],
  [
    "hosted runtime stopped",
    endedTurn,
    "dormant",
    { hostedStopped: true },
    { agentStatus: "stopped" },
  ],
  [
    "compacting",
    ready,
    "blocked",
    { compacting: true },
    { agentStatus: "compacting" },
  ],
];

test.each(cases)(
  "%s agrees with the inbox classifier",
  (name, state, pin, visibility, legacy) => {
    const random = testFaker(`work-state-parity:${name}`);
    for (let sample = 0; sample < 15; sample += 1) {
      const transcriptLength = random.number.int({ min: 1, max: 200 });
      const projectionPin =
        pin ?? (random.datatype.boolean() ? "working" : null);
      let scenario = state;
      for (let index = random.number.int({ max: 8 }); index > 0; index -= 1) {
        const input = {
          ...submit,
          seq: scenario.lastInboxSeq + 1,
          delivery_id: `settled-${index}`,
        };
        scenario = applyFacts(scenario, input, {
          ...input,
          kind: "inbox.cancelled",
        });
      }
      const expected = classifyWorkState({
        isIdle: true,
        awaitingInput: false,
        hasPending: false,
        isUnresponsive: false,
        messageCount: transcriptLength,
        declaredStatus: projectionPin,
        ...legacy,
      });
      expect(
        sessionMachine.whoActsNext(scenario, projectionPin, visibility),
      ).toBe(expected);
    }
  },
);
