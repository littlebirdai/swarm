import type { Expected, PromptOpened } from "@codecast/edge-contract";

export type Person = "ana" | "ben" | "visitor";
export type TurnExpected = Extract<Expected, { kind: "turn" }>;
export type PromptExpected = Extract<Expected, { kind: "prompt" }>;
export type Outcome = "delivered" | "stale" | "queued" | "in_doubt" | "refused";
export type MessageState =
  | Outcome
  | "waiting"
  | "waiting_for_machine"
  | "suggestion";

export type Send = {
  id: string;
  from: Person;
  text: string;
  intent: "steer" | "queue";
  expected?: TurnExpected;
};

export type Permit = Send & { attemptId: number; fenceId: number };
export type Fence = { fenceId: number };
export type Started = { outcome: "started"; permit: Permit };
export type Delivery = { id: string; from: Person; text: string; turn: string };
export type Turn = { id: string; starter: Person };
export type Prompt = {
  run: number;
  opened: PromptOpened;
  verifiedKind?: "workspace_read" | "question";
};
export type PromptCard = {
  expected: PromptExpected;
  class: "routine" | "escalation";
  state: "open" | "answered" | "closed";
  answeredBy: Person | null;
  canAnswer: Person | null;
  answererOnline: boolean;
};

export type Snapshot = { files: string[]; decisions: string[] };
export type View = {
  driver: Person | null;
  action: "Send" | "Queue" | "Take over" | "Taking over" | "Read";
  turn: string | null;
  messages: { id: string; state: MessageState }[];
  composer: { text: string; offerQueue: boolean };
  transcript: Delivery[];
  presence: Person | null;
  snapshot: (Snapshot & { lastRead: string | null }) | null;
  prompt: PromptCard | null;
};

export type Channel =
  | "server:presence"
  | "server:start"
  | `server:start:${Person}`
  | "server:settlement"
  | "server:control"
  | "server:turn"
  | `server:read:${Person}`
  | "server:prompt"
  | "machine:permit"
  | "machine:handoff"
  | "machine:fence"
  | "machine:connection"
  | "machine:interrupt"
  | "machine:answer"
  | "clock"
  | "agent"
  | "relay"
  | `client:${Person}:durable`
  | `client:${Person}:relay`;
export type Wire = <T>(
  channel: Channel,
  label: string,
  act: () => T,
) => Promise<T>;

export const BATON_LEASE_MS = 30_000;

export interface MultiplayerSession {
  join(person: Person): Promise<void>;
  leave(person: Person): Promise<void>;
  renew(person: Person): Promise<void>;
  revoke(person: Person): Promise<void>;
  submit(send: Send): Promise<Started | Outcome>;
  retryQueuedSteer(
    id: string,
    from: Person,
    expected: TurnExpected,
  ): Promise<Started | Outcome>;
  releaseQueue(): Promise<Started | Outcome>;
  receivePermit(permit: Permit): Promise<boolean>;
  hand(permit: Permit): Promise<Outcome | "handed">;
  land(permit: Permit): Promise<Outcome>;
  settle(permit: Permit, outcome: Outcome): Promise<Outcome>;
  requestTakeover(): Promise<Fence>;
  confirmTakeover(fence: Fence): Promise<boolean>;
  receiveFence(fence: Fence): Promise<void>;
  acknowledgeFence(fence: Fence): Promise<boolean>;
  machineTurn(turn: Turn | null): Promise<void>;
  publishTurn(): Promise<void>;
  interrupt(from: Person, expected?: TurnExpected): Promise<Outcome>;
  elapse(ms: number): Promise<void>;
  disconnect(): Promise<void>;
  restart(): Promise<void>;
  reconcile(permit: Permit): Promise<Outcome>;
  announcePresence(person: Person): Promise<void>;
  relayHeartbeat(person: Person): Promise<void>;
  killRelay(): Promise<void>;
  publishSnapshot(snapshot: Snapshot): Promise<void>;
  markRead(person: Person, event: string): Promise<void>;
  openPrompt(prompt: Prompt): Promise<void>;
  closePrompt(): Promise<void>;
  publishPrompt(): Promise<void>;
  prepareAnswer(
    person: Person,
    expected?: PromptExpected,
  ): Promise<PromptExpected | Outcome>;
  deliverAnswer(expected: PromptExpected): Promise<Outcome>;
  receiveDurable(person: Person): Promise<void>;
  receiveRelay(person: Person): Promise<void>;
  view(person: Person): View;
  extraWrites(): { claim: number; presence: number };
}
