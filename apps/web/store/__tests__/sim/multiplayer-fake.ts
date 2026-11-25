import { classifyPrompt, matchesExpected } from "@codecast/edge-contract";
import {
  BATON_LEASE_MS,
  type Delivery,
  type Fence,
  type MessageState,
  type MultiplayerSession,
  type Outcome,
  type Permit,
  type Person,
  type Prompt,
  type PromptCard,
  type PromptExpected,
  type Send,
  type Snapshot,
  type Started,
  type Turn,
  type TurnExpected,
  type View,
  type Wire,
} from "./multiplayer-contract";

const OWNER = "ana";
const PEOPLE: Person[] = ["ana", "ben", "visitor"];
const EMPTY_COMPOSER = { text: "", offerQueue: false };

function emptyView(): View {
  return {
    driver: null,
    action: "Read",
    turn: null,
    messages: [],
    composer: EMPTY_COMPOSER,
    transcript: [],
    presence: null,
    snapshot: null,
    prompt: null,
  };
}

export function fakeMultiplayerSession(
  wire: Wire,
  now: () => number,
  advance: (ms: number) => void,
): MultiplayerSession {
  const storage = {
    claim: null as {
      holder: Person;
      expiresAt: number;
    } | null,
    writes: { claim: 0, presence: 0 },
  };
  const server = {
    senders: new Set<Person>(["ana", "ben"]),
    present: new Set<Person>(),
    machineOnline: true,
    messages: new Map<string, { input: Send; state: MessageState }>(),
    transcript: [] as Delivery[],
    turn: null as Turn | null,
    impliedDriver: null as Person | null,
    active: null as Permit | null,
    takeover: null as Fence | null,
    fenceId: 0,
    nextAttempt: 0,
    prompt: null as Omit<PromptCard, "canAnswer" | "answererOnline"> | null,
    snapshot: null as Snapshot | null,
    lastRead: new Map<Person, string>(),
  };
  const machine = {
    online: true,
    fenceId: 0,
    inbox: new Map<number, Permit>(),
    journal: new Map<number, Permit>(),
  };
  const agent = {
    turn: null as Turn | null,
    deliveries: [] as Delivery[],
    prompt: null as Prompt | null,
  };
  const relay = { online: true, presence: null as Person | null };
  const clients = new Map(PEOPLE.map((person) => [person, emptyView()]));

  function write(
    kind: "claim" | "presence",
    claim: typeof storage.claim = null,
  ) {
    if (kind === "claim") storage.claim = claim;
    storage.writes[kind]++;
  }

  function anotherSender(person: Person) {
    return [...server.present].some(
      (other) => other !== person && server.senders.has(other),
    );
  }

  function activeClaim() {
    return storage.claim && storage.claim.expiresAt > now()
      ? storage.claim
      : null;
  }

  function driver(): Person | null {
    return activeClaim()?.holder ?? server.impliedDriver;
  }

  function claim(holder: Person) {
    if (activeClaim()?.holder !== holder) server.fenceId++;
    write("claim", { holder, expiresAt: now() + BATON_LEASE_MS });
    server.impliedDriver = null;
  }

  function release(person: Person) {
    if (storage.claim?.holder === person) write("claim");
    if (server.impliedDriver === person) server.impliedDriver = null;
  }

  function finishTakeover(acknowledged = false) {
    if (!server.takeover || (server.active && !acknowledged)) return;
    claim(OWNER);
    server.takeover = null;
  }

  function observeTurn(turn: Turn | null): TurnExpected {
    return { kind: "turn", turn: turn?.id ?? null };
  }

  function promptKey(prompt: Prompt): PromptExpected {
    return {
      kind: "prompt",
      prompt_id: prompt.opened.prompt_id,
      run: prompt.run,
    };
  }

  function answerer(card: Pick<PromptCard, "class">): Person {
    return card.class === "escalation" ? OWNER : (driver() ?? OWNER);
  }

  function start(send: Send): Started | Outcome {
    const { from, expected, intent } = send;
    if (!server.senders.has(from)) return "refused";
    if (!matchesExpected(expected, observeTurn(server.turn))) return "stale";
    if (server.takeover || server.active) return "queued";
    if (intent === "queue" && server.turn) return "queued";
    const holder = driver();
    if (intent === "steer" && holder && holder !== from) {
      if (server.impliedDriver) claim(holder);
      return "queued";
    }
    if (!server.machineOnline) return "queued";
    if (intent === "steer" && !holder && (server.turn || anotherSender(from)))
      claim(from);
    const permit = {
      ...send,
      attemptId: ++server.nextAttempt,
      fenceId: server.fenceId,
    };
    server.active = permit;
    return { outcome: "started", permit };
  }

  function messageState(result: Started | Outcome): MessageState {
    if (typeof result !== "string") return "waiting";
    return result === "queued" && !server.machineOnline
      ? "waiting_for_machine"
      : result;
  }

  function publishAgentTurn(turn: Turn | null) {
    if (server.turn?.id !== turn?.id) {
      const starter = turn?.starter;
      server.impliedDriver =
        !activeClaim() && starter && server.senders.has(starter)
          ? starter
          : null;
    }
    server.turn = turn;
  }

  function durableSnapshot(person: Person) {
    const holder = driver();
    let action: View["action"] = "Send";
    if (!server.senders.has(person)) action = "Read";
    else if (server.takeover) action = "Taking over";
    else if (holder && holder !== person)
      action = person === OWNER ? "Take over" : "Queue";

    const messages = Array.from(server.messages, ([id, { state }]) => ({
      id,
      state,
    }));
    const staleDrafts = [...server.messages.values()]
      .filter(({ input, state }) => input.from === person && state === "stale")
      .map(({ input }) => ({ id: input.id, text: input.text }));
    const canAnswer =
      server.prompt?.state === "open" ? answerer(server.prompt) : null;
    return {
      staleDrafts,
      view: {
        driver: holder,
        action,
        turn: server.turn?.id ?? null,
        messages,
        transcript: [...server.transcript],
        snapshot: server.snapshot && {
          ...server.snapshot,
          lastRead: server.lastRead.get(person) ?? null,
        },
        prompt: server.prompt && {
          ...server.prompt,
          canAnswer,
          answererOnline: canAnswer !== null && server.present.has(canAnswer),
        },
      },
    };
  }

  function hasReceipt(id: string) {
    return agent.deliveries.some((delivery) => delivery.id === id);
  }

  function settle(permit: Permit, outcome: Outcome) {
    const deliveries =
      outcome === "delivered"
        ? agent.deliveries.filter(({ id }) => id === permit.id)
        : [];
    return wire("server:settlement", `settle ${permit.id}: ${outcome}`, () => {
      if (
        server.active?.id !== permit.id ||
        server.active.attemptId !== permit.attemptId ||
        server.active.fenceId !== permit.fenceId
      )
        return "refused";
      if (outcome === "delivered" && deliveries.length === 0) return "refused";
      server.messages.get(permit.id)!.state = outcome;
      if (outcome === "in_doubt") return outcome;
      if (outcome === "delivered") {
        server.transcript.push(...deliveries);
      }
      server.active = null;
      return outcome;
    });
  }

  return {
    join: (person) =>
      wire(
        "server:presence",
        `${person} joins`,
        () => void server.present.add(person),
      ),
    leave: (person) =>
      wire(
        "server:presence",
        `${person} leaves`,
        () => void server.present.delete(person),
      ),
    release: (person) =>
      wire("server:control", `${person} releases the baton`, () =>
        release(person),
      ),
    renew: (person) =>
      wire("server:presence", `${person} renews`, () => {
        if (
          activeClaim()?.holder === person &&
          server.present.has(person) &&
          anotherSender(person) &&
          !server.takeover
        )
          claim(person);
      }),
    revoke: (person) =>
      wire("server:control", `revoke ${person}`, () => {
        server.senders.delete(person);
        release(person);
        for (const message of server.messages.values()) {
          if (
            message.input.from === person &&
            (message.state === "queued" ||
              message.state === "waiting_for_machine")
          )
            message.state = "suggestion";
        }
      }),
    submit(send) {
      clients.get(send.from)!.composer = EMPTY_COMPOSER;
      return wire(
        `server:start:${send.from}`,
        `start ${send.id} from ${send.from}`,
        () => {
          const previous = server.messages.get(send.id);
          if (previous) {
            const { state } = previous;
            if (state === "suggestion") return "refused";
            return state === "waiting" || state === "waiting_for_machine"
              ? "queued"
              : state;
          }
          const result = start(send);
          server.messages.set(send.id, {
            input: send,
            state: messageState(result),
          });
          return result;
        },
      );
    },
    retryQueuedSteer: (id, from, expected) =>
      wire("server:start", `steer ${id} now`, () => {
        const message = server.messages.get(id);
        if (
          !message ||
          (message.state !== "queued" &&
            message.state !== "waiting_for_machine") ||
          message.input.from !== from
        )
          return "refused";
        message.input = { ...message.input, intent: "steer", expected };
        const result = start(message.input);
        message.state = messageState(result);
        return result;
      }),
    releaseQueue: () =>
      wire("server:start", "release the queue", () => {
        if (server.turn || server.active || server.takeover) return "queued";
        const entry = [...server.messages.values()].find(
          ({ state }) => state === "queued",
        );
        if (!entry) return "refused";
        const result = start({
          ...entry.input,
          intent: "queue",
          expected: { kind: "turn", turn: null },
        });
        entry.state = messageState(result);
        return result;
      }),
    receivePermit: (permit) =>
      wire("machine:permit", `receive ${permit.id}`, () => {
        if (machine.online) machine.inbox.set(permit.attemptId, permit);
      }),
    hand: (permit) =>
      wire("machine:handoff", `hand ${permit.id}`, () => {
        if (machine.journal.has(permit.attemptId)) return "in_doubt";
        const received = machine.inbox.get(permit.attemptId);
        if (!received) return "in_doubt";
        if (received.fenceId < machine.fenceId) return "queued";
        if (!matchesExpected(received.expected, observeTurn(agent.turn)))
          return "stale";
        machine.journal.set(permit.attemptId, received);
        return "handed";
      }),
    land: (permit) =>
      wire("agent", `land ${permit.id}`, () => {
        const handed = machine.journal.get(permit.attemptId);
        if (!handed) return "refused";
        if (hasReceipt(handed.id)) return "delivered";
        agent.turn ??= { id: handed.id, starter: handed.from };
        agent.deliveries.push({
          id: handed.id,
          from: handed.from,
          turn: agent.turn.id,
          text: handed.text,
        });
        return "delivered";
      }),
    settle,
    requestTakeover: () =>
      wire("server:control", "request takeover", () => {
        if (server.takeover) return server.takeover;
        const fence = { fenceId: ++server.fenceId };
        server.takeover = fence;
        finishTakeover();
        return fence;
      }),
    confirmTakeover: (fence) =>
      wire("server:control", `finish takeover ${fence.fenceId}`, () => {
        if (server.takeover?.fenceId !== fence.fenceId) return false;
        finishTakeover();
        return !server.takeover;
      }),
    receiveFence: (fence) =>
      wire("machine:fence", `receive fence ${fence.fenceId}`, () => {
        if (machine.online)
          machine.fenceId = Math.max(machine.fenceId, fence.fenceId);
      }),
    async acknowledgeFence(fence) {
      const ack = await wire("machine:fence", "check fence ack", () => {
        if (!machine.online || machine.fenceId !== fence.fenceId) return false;
        const unlanded = [...machine.journal.values()].some(
          ({ fenceId, id }) => fenceId < fence.fenceId && !hasReceipt(id),
        );
        return !unlanded;
      });
      if (!ack) return false;
      return wire("server:control", "record fence ack", () => {
        if (server.takeover?.fenceId !== fence.fenceId) return false;
        finishTakeover(true);
        return true;
      });
    },
    machineTurn: (turn) =>
      wire("agent", `turn ${turn?.id ?? "ends"}`, () => {
        agent.turn = turn;
      }),
    publishTurn() {
      const { turn } = agent;
      return wire("server:turn", "publish the agent turn", () =>
        publishAgentTurn(turn),
      );
    },
    async interrupt(from, expected) {
      const status = await wire("server:start", `stop from ${from}`, () => {
        if (!server.senders.has(from) || (from !== OWNER && from !== driver()))
          return "refused";
        return matchesExpected(expected, observeTurn(server.turn))
          ? "started"
          : "stale";
      });
      if (status !== "started") return { outcome: status, stage: "server" };
      const outcome = await wire("machine:interrupt", "interrupt turn", () => {
        if (!machine.online) return "in_doubt";
        if (!matchesExpected(expected, observeTurn(agent.turn))) return "stale";
        agent.turn = null;
        return "delivered";
      });
      return { outcome, stage: "machine" };
    },
    elapse: (ms) => wire("clock", `advance ${ms}ms`, () => advance(ms)),
    disconnect: () =>
      wire("machine:connection", "machine disconnects", () => {
        machine.online = false;
      }).then(() =>
        wire("server:control", "server learns the machine is offline", () => {
          server.machineOnline = false;
          if (server.active)
            server.messages.get(server.active.id)!.state = "in_doubt";
        }),
      ),
    restart: () =>
      wire("machine:connection", "machine restarts with an empty inbox", () => {
        machine.inbox.clear();
        machine.fenceId = 0;
        machine.online = true;
      }).then(() =>
        wire("server:control", "server learns the machine is online", () => {
          server.machineOnline = true;
        }),
      ),
    reconcile: (permit) =>
      wire("machine:handoff", `reconcile ${permit.id} from the journal`, () => {
        if (!machine.journal.has(permit.attemptId)) return "queued";
        return hasReceipt(permit.id) ? "delivered" : "in_doubt";
      }).then((outcome) => settle(permit, outcome)),
    announcePresence: (person) =>
      wire("server:presence", `announce presence for ${person}`, () => {
        if (anotherSender(person) && server.senders.has(person))
          write("presence");
      }),
    relayHeartbeat: (person) =>
      wire("relay", `heartbeat from ${person}`, () => {
        if (relay.online && anotherSender(person) && server.senders.has(person))
          relay.presence = person;
      }),
    killRelay: () =>
      wire("relay", "relay stops", () => {
        relay.online = false;
        relay.presence = null;
      }),
    publishSnapshot: (snapshot) =>
      wire("server:turn", "publish turn snapshot", () => {
        server.snapshot = snapshot;
      }),
    markRead: (person, event) =>
      wire("server:turn", `${person} marks a read point`, () => {
        server.lastRead.set(person, event);
      }),
    openPrompt: (prompt) =>
      wire("agent", "open prompt", () => {
        agent.prompt = prompt;
      }),
    closePrompt: () =>
      wire("agent", "agent closes the prompt", () => {
        agent.prompt = null;
      }),
    publishPrompt() {
      const { prompt } = agent;
      return wire("server:prompt", "publish the prompt event", () => {
        if (!prompt) {
          if (server.prompt) server.prompt.state = "closed";
          return;
        }
        const key = promptKey(prompt);
        if (server.prompt && matchesExpected(server.prompt.expected, key))
          return;
        server.prompt = {
          expected: key,
          class: classifyPrompt(prompt.opened, prompt.verifiedKind),
          state: "open",
          answeredBy: null,
        };
      });
    },
    prepareAnswer: (person, expected) =>
      wire("server:prompt", `check answer from ${person}`, () => {
        const { prompt } = server;
        if (
          !prompt ||
          prompt.state !== "open" ||
          !server.senders.has(person) ||
          person !== answerer(prompt)
        )
          return "refused";
        if (!matchesExpected(expected, prompt.expected)) return "stale";
        prompt.state = "answered";
        prompt.answeredBy = person;
        return prompt.expected;
      }),
    deliverAnswer: (expected) =>
      wire("machine:answer", "deliver the prompt answer", () => {
        if (!machine.online) return "in_doubt";
        if (
          !agent.prompt ||
          !matchesExpected(expected, promptKey(agent.prompt))
        )
          return "stale";
        agent.prompt = null;
        return "delivered";
      }).then((outcome) =>
        wire("server:prompt", `record answer outcome ${outcome}`, () => {
          if (
            outcome === "stale" &&
            server.prompt &&
            matchesExpected(expected, server.prompt.expected)
          ) {
            server.prompt.state = "closed";
            server.prompt.answeredBy = null;
          }
          return outcome;
        }),
      ),
    receiveDurable: (person) =>
      wire(`server:read:${person}`, `read durable state for ${person}`, () =>
        durableSnapshot(person),
      ).then(({ view, staleDrafts }) =>
        wire(
          `client:${person}:durable`,
          `${person} receives durable state`,
          () => {
            const client = clients.get(person)!;
            for (const { id, text } of staleDrafts) {
              if (
                !client.messages.some(
                  (entry) => entry.id === id && entry.state === "stale",
                )
              ) {
                client.composer = { text, offerQueue: true };
              }
            }
            Object.assign(client, view);
          },
        ),
      ),
    async receiveRelay(person) {
      const presence = await wire(
        "relay",
        "read presence",
        () => relay.presence,
      );
      await wire(`client:${person}:relay`, "receive presence", () => {
        clients.get(person)!.presence = presence;
      });
    },
    view: (person) => ({ ...clients.get(person)! }),
    extraWrites: () => ({ ...storage.writes }),
  };
}
