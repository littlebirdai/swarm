import {
  matchesExpected,
  type Expected,
} from "../../../../../packages/edge-contract/src/index";

export type Person = "ana" | "ben";
type TurnExpected = Extract<Expected, { kind: "turn" }>;
type PromptExpected = Extract<Expected, { kind: "prompt" }>;
type Prompt = PromptExpected & { class: "routine" | "escalation" };
type Send = {
  id: string;
  from: Person;
  text: string;
  expected: TurnExpected;
};
type MessageState = "waiting" | "queued" | "stale" | "delivered";
type Delivered = { id: string; from: Person; text: string; turn: string };
type TurnSnapshot = { files: string[]; decisions: string[] };

export interface MultiplayerSession {
  join(person: Person): void;
  leave(person: Person): void;
  renew(person: Person): void;
  press(send: Send): void;
  start(id: string): void;
  retryQueuedSteer(id: string, from: Person, expected: TurnExpected): void;
  hand(id: string): void;
  land(id: string): void;
  settleDelivery(id: string): void;
  releaseQueue(): void;
  requestTakeover(): void;
  receiveFence(): void;
  acknowledgeFence(): void;
  machineTurn(turn: string | null): void;
  publishTurn(): void;
  relayHeartbeat(person: Person): void;
  killRelay(): void;
  markRead(person: Person, event: string): void;
  saveSnapshot(snapshot: TurnSnapshot): void;
  machinePrompt(prompt: Prompt): void;
  publishPrompt(): void;
  answer(person: Person, expected: PromptExpected): void;
  deliverAnswer(): void;
  view(person: Person): {
    driver: Person | null;
    action: "Send" | "Queue" | "Take over" | "Taking over";
    messages: { id: string; state: MessageState }[];
    composer: { text: string; offerQueue: boolean };
    transcript: Delivered[];
    presence: Person | null;
    snapshot: (TurnSnapshot & { lastRead: string | null }) | null;
    prompt:
      | (Prompt & { canAnswer: Person | null; answeredBy: Person | null })
      | null;
  };
  extraWrites(): number;
}

const OWNER = "ana";
export const BATON_LEASE_MS = 30_000;

export function fakeMultiplayerSession(now: () => number): MultiplayerSession {
  const present = new Set<Person>();
  const messages = new Map<string, { send: Send; state: MessageState }>();
  const drafts = new Map<Person, { text: string; offerQueue: boolean }>();
  const lastRead = new Map<Person, string>();
  let snapshot: TurnSnapshot | null = null;
  const transcript: Delivered[] = [];
  const receipts = new Set<string>();
  let claim: { holder: Person; expiresAt: number } | null = null;
  let writes = 0;
  let machineTurn: string | null = null;
  let serverTurn: string | null = null;
  let starter: Person | null = null;
  let impliedDriver = false;
  let inFlight: { id: string; handed: boolean; queued: boolean } | null = null;
  let takeover = false;
  let fenced = false;
  let relayUp = true;
  let presence: Person | null = null;
  let machinePrompt: Prompt | null = null;
  let card: { prompt: Prompt; answeredBy: Person | null } | null = null;
  const commands: PromptExpected[] = [];

  function claimBaton(holder: Person) {
    claim = { holder, expiresAt: now() + BATON_LEASE_MS };
    impliedDriver = false;
    writes++;
  }

  function driver(): Person | null {
    if (claim && claim.expiresAt > now()) return claim.holder;
    return impliedDriver && serverTurn ? starter : null;
  }

  function canAnswer(prompt: Prompt): Person {
    return prompt.class === "escalation" ? OWNER : (driver() ?? OWNER);
  }

  function refuseStale(id: string) {
    const message = messages.get(id)!;
    message.state = "stale";
    drafts.set(message.send.from, {
      text: message.send.text,
      offerQueue: true,
    });
  }

  function finishTakeover() {
    if (!takeover || inFlight) return;
    claimBaton(OWNER);
    takeover = false;
  }

  return {
    join(person) {
      present.add(person);
    },
    leave(person) {
      present.delete(person);
    },
    renew(person) {
      if (!claim || claim.holder !== person || claim.expiresAt <= now()) return;
      if (!present.has(person) || present.size < 2 || takeover) return;
      claimBaton(person);
    },
    press(send) {
      if (messages.has(send.id)) return;
      messages.set(send.id, { send, state: "waiting" });
      drafts.set(send.from, { text: "", offerQueue: false });
    },
    start(id) {
      const message = messages.get(id);
      if (message?.state !== "waiting") return;
      const { from, expected } = message.send;
      if (!matchesExpected(expected, { kind: "turn", turn: serverTurn })) {
        refuseStale(id);
        return;
      }
      if (takeover) {
        message.state = "queued";
        return;
      }
      const holder = driver();
      if (holder && holder !== from && serverTurn) {
        if (impliedDriver) claimBaton(holder);
        message.state = "queued";
        return;
      }
      if (inFlight) {
        message.state = "queued";
        return;
      }
      if (!holder && (present.size > 1 || claim)) claimBaton(from);
      inFlight = { id, handed: false, queued: false };
    },
    retryQueuedSteer(id, from, expected) {
      const message = messages.get(id);
      if (message?.state !== "queued" || message.send.from !== from) return;
      message.send = { ...message.send, expected };
      message.state = "waiting";
    },
    hand(id) {
      if (inFlight?.id !== id || inFlight.handed) return;
      if (takeover && fenced && !inFlight.queued) return;
      const { expected } = messages.get(id)!.send;
      if (
        !inFlight.queued &&
        !matchesExpected(expected, { kind: "turn", turn: machineTurn })
      ) {
        refuseStale(id);
        inFlight = null;
        finishTakeover();
        return;
      }
      inFlight.handed = true;
    },
    land(id) {
      if (inFlight?.id !== id || !inFlight.handed || receipts.has(id)) return;
      const message = messages.get(id)!;
      const { from, text } = message.send;
      if (machineTurn === null) {
        machineTurn = id;
        starter = from;
        impliedDriver = driver() === null;
      }
      transcript.push({ id, from, text, turn: machineTurn });
      receipts.add(id);
      message.state = "delivered";
    },
    settleDelivery(id) {
      if (inFlight?.id !== id || !receipts.has(id)) return;
      inFlight = null;
      finishTakeover();
    },
    releaseQueue() {
      if (machineTurn !== null || serverTurn !== null || inFlight || takeover)
        return;
      for (const { send, state } of messages.values()) {
        if (state !== "queued") continue;
        inFlight = { id: send.id, handed: false, queued: true };
        return;
      }
    },
    requestTakeover() {
      if (driver() === OWNER || takeover) return;
      takeover = true;
      fenced = false;
      finishTakeover();
    },
    receiveFence() {
      fenced = takeover;
    },
    acknowledgeFence() {
      if (!fenced || inFlight?.handed) return;
      if (inFlight) messages.get(inFlight.id)!.state = "queued";
      inFlight = null;
      finishTakeover();
    },
    machineTurn(turn) {
      machineTurn = turn;
    },
    publishTurn() {
      serverTurn = machineTurn;
    },
    relayHeartbeat(person) {
      if (relayUp) presence = person;
    },
    killRelay() {
      relayUp = false;
      presence = null;
    },
    markRead(person, event) {
      lastRead.set(person, event);
    },
    saveSnapshot(value) {
      snapshot = value;
    },
    machinePrompt(prompt) {
      machinePrompt = prompt;
    },
    publishPrompt() {
      if (!machinePrompt) {
        if (!card?.answeredBy) card = null;
      } else if (!card || !matchesExpected(card.prompt, machinePrompt)) {
        card = { prompt: machinePrompt, answeredBy: null };
      }
    },
    answer(person, expected) {
      if (!card || card.answeredBy || person !== canAnswer(card.prompt)) return;
      if (!matchesExpected(expected, card.prompt)) return;
      card.answeredBy = person;
      commands.push(expected);
    },
    deliverAnswer() {
      const command = commands.shift();
      if (!command) return;
      const observed = machinePrompt ?? {
        kind: "prompt",
        run: null,
        prompt_id: null,
      };
      if (matchesExpected(command, observed)) machinePrompt = null;
      else if (card && matchesExpected(command, card.prompt)) card = null;
    },
    view(person) {
      const holder = driver();
      let action: ReturnType<MultiplayerSession["view"]>["action"] = "Send";
      if (takeover) action = "Taking over";
      else if (holder && holder !== person)
        action = person === OWNER ? "Take over" : "Queue";
      return {
        driver: holder,
        action,
        messages: Array.from(messages, ([id, { state }]) => ({ id, state })),
        composer: drafts.get(person) ?? { text: "", offerQueue: false },
        transcript: [...transcript],
        presence,
        snapshot: snapshot && {
          ...snapshot,
          lastRead: lastRead.get(person) ?? null,
        },
        prompt: card && {
          ...card.prompt,
          canAnswer: card.answeredBy ? null : canAnswer(card.prompt),
          answeredBy: card.answeredBy,
        },
      };
    },
    extraWrites: () => writes,
  };
}
