import { expect, test } from "bun:test";
import type { CanonicalEvent, MessageDelta } from "@codecast/edge-contract";
import {
  negotiateCapabilities,
  type ProviderEvent,
  type ProviderOffer,
} from "../src";
import { providerConformance } from "@codecast/provider-contract/test";
import { fakeProvider } from "./fake-provider";

const dialects = {
  sdk: {
    agent: "claude",
    version: "2.1.248",
    capabilities: ["own", "steer-mid-turn", "interrupt", "prompts", "resume"],
  },
  "app-server": {
    agent: "codex",
    version: "fixture",
    capabilities: ["own", "interrupt", "prompts", "resume"],
  },
  acp: {
    agent: "grok",
    version: "fixture",
    capabilities: ["own", "interrupt", "prompts", "resume"],
  },
  "transcript plus paste": {
    agent: "gemini",
    version: "fixture",
    capabilities: [],
  },
  "receipt-capable SDK fixture": {
    agent: "claude",
    version: "durable-receipt-fixture",
    capabilities: [
      "own",
      "receipts",
      "steer-mid-turn",
      "interrupt",
      "prompts",
      "resume",
    ],
  },
} as const satisfies Record<string, ProviderOffer>;

const cancelSent = {
  status: "in-doubt",
  reason: "best-effort",
  code: "CANCEL_SENT",
  message: "The cancel notification was written",
} as const;

const answerSent = {
  status: "in-doubt",
  reason: "best-effort",
  code: "ANSWER_SENT",
  message: "The transport accepted the answer",
} as const;

for (const [name, provider] of Object.entries(dialects)) {
  providerConformance(name, () =>
    fakeProvider(provider, {
      interrupt: name === "acp" ? cancelSent : undefined,
      answer: name === "app-server" || name === "acp" ? answerSent : undefined,
    }),
  );
}

providerConformance("owned session with restricted capabilities", () =>
  fakeProvider({
    ...dialects["app-server"],
    capabilities: ["own"],
  }),
);

type SameGrammar = [ProviderEvent] extends [CanonicalEvent | MessageDelta]
  ? [CanonicalEvent | MessageDelta] extends [ProviderEvent]
    ? true
    : false
  : false;

test("provider grammar matches edge events in both directions", () => {
  const exact: SameGrammar = true;
  expect(exact).toBe(true);
});

test("negotiation uses the exact agent and version", () => {
  const sdk = dialects.sdk;
  const offers = [
    dialects["receipt-capable SDK fixture"],
    { ...dialects["app-server"], version: sdk.version },
    sdk,
  ];
  const allowed = dialects["receipt-capable SDK fixture"].capabilities;
  expect(negotiateCapabilities(sdk, offers, allowed)).toEqual(sdk);
  const unknownVersion = { agent: sdk.agent, version: "unknown" };
  expect(negotiateCapabilities(unknownVersion, offers, allowed)).toEqual({
    ...unknownVersion,
    capabilities: [],
  });
  expect(
    negotiateCapabilities({ ...sdk, agent: "unknown" }, offers, allowed),
  ).toEqual({
    agent: "unknown",
    version: sdk.version,
    capabilities: [],
  });
});

test("negotiation intersects exact offers and policy in stable capability order", () => {
  const sdk = dialects["receipt-capable SDK fixture"];
  expect(
    negotiateCapabilities(
      sdk,
      [sdk, { ...sdk, capabilities: ["own", "prompts", "resume"] }],
      ["resume", "receipts", "own", "own"],
    ),
  ).toEqual({ ...sdk, capabilities: ["own", "resume"] });
});

test("negotiation clears owned capabilities when ownership is unavailable", () => {
  const sdk = dialects.sdk;
  expect(
    negotiateCapabilities(sdk, [sdk], ["steer-mid-turn", "resume"]),
  ).toEqual({
    ...sdk,
    capabilities: [],
  });
});

test("an owned-capable provider can open a read-only observation", async () => {
  const fixture = fakeProvider(dialects.sdk);
  const result = await fixture.adapter.observe({
    session: "observed",
    run: 1,
    afterSeq: 0,
    transcript: "/transcript",
  });
  if (result.status !== "opened") throw new Error("Expected observation");
  const { session } = result;
  try {
    expect(session.mode).toBe("observe");
    expect(await session.steer(fixture.steer)).toEqual({
      status: "unsupported",
      requires: "paste-target",
    });
    expect(await session.interrupt(fixture.interrupt)).toEqual({
      status: "unsupported",
      requires: "owned-session",
    });
    expect(await session.answer(fixture.answer)).toEqual({
      status: "unsupported",
      requires: "owned-session",
    });
    expect(fixture.effects()).toEqual([]);
  } finally {
    await session.close();
  }
});

providerConformance("receipts without resume", () =>
  fakeProvider({ ...dialects.sdk, capabilities: ["own", "receipts"] }),
);

providerConformance("read-only observer", () =>
  fakeProvider(dialects["transcript plus paste"], { readOnly: true }),
);

providerConformance("stateful idle-steer", () =>
  fakeProvider(
    { ...dialects.sdk, capabilities: ["own", "receipts"] },
    { startTurnOnSteer: true },
  ),
);

providerConformance("stable checkpoint with wrapped defect", () =>
  fakeProvider(
    { ...dialects.sdk, capabilities: ["own", "resume"] },
    { stableCheckpoint: true, failOnOverflow: true },
  ),
);

providerConformance("event-driven turn", () =>
  fakeProvider(
    { ...dialects.sdk, capabilities: ["own", "interrupt", "prompts"] },
    { eventDrivenTurn: true },
  ),
);
