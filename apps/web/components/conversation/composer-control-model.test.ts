import { expect, test } from "bun:test";
import {
  composerControlModel,
  type ComposerControlFacts,
} from "./composer-control-model";

const ana = { id: "ana", name: "Ana" };
const me = { id: "me", name: "Casey" };
const base: ComposerControlFacts = {
  viewerId: me.id,
  role: "sender",
  driver: ana,
  turn: "t1",
  takeoverPending: false,
  driveRequested: false,
  sendState: null,
};

type View = ReturnType<typeof composerControlModel>;
const cases: [string, Partial<ComposerControlFacts>, Partial<View>][] = [
  [
    "viewer asks to drive",
    { role: "viewer" },
    {
      driver: "Ana",
      send: null,
      request: "ask",
      takeover: null,
    },
  ],
  [
    "suggester has a request pending",
    { role: "suggester", driveRequested: true },
    { send: "suggest", request: "requested", interrupt: false },
  ],
  [
    "sender queues behind the driver",
    {},
    {
      driver: "Ana",
      send: "queue",
      request: null,
      takeover: null,
    },
  ],
  [
    "sender can take a free turn",
    { driver: null },
    { driver: null, send: "send" },
  ],
  [
    "holder can steer with the owner offline",
    { driver: me },
    { driver: "You", send: "send", takeover: null, interrupt: true },
  ],
  [
    "owner can take over or queue",
    { role: "owner" },
    { driver: "Ana", send: "queue", takeover: "takeover", interrupt: true },
  ],
  [
    "owner already drives",
    { role: "owner", driver: me },
    { driver: "You", send: "send", takeover: null, interrupt: true },
  ],
  [
    "owner can drive after the holder leaves with a prompt open",
    { role: "owner", driver: null },
    { driver: null, send: "send", takeover: null },
  ],
  [
    "owner queues while the takeover waits",
    { role: "owner", takeoverPending: true, driver: null },
    {
      send: "queue",
      takeover: "cancel",
      takeoverStatus: "Taking over · Waiting for the machine",
    },
  ],
  [
    "old holder queues during takeover",
    { takeoverPending: true, driver: me },
    { send: "queue", takeover: null },
  ],
  [
    "revoked sender sees the suggestion and can request access",
    { role: "suggester", sendState: { kind: "suggested" } },
    { send: "suggest", request: "ask", sendStatus: "Suggested" },
  ],
  [
    "machine offline keeps the driver and shows where the send waits",
    { driver: me, sendState: { kind: "waiting-for-machine" } },
    { driver: "You", sendStatus: "Waiting for the machine" },
  ],
  [
    "relay lost leaves durable facts sufficient",
    { sendState: { kind: "waiting-for-driver", driver: "Ana" } },
    { send: "queue", sendStatus: "Waiting for Ana" },
  ],
  [
    "stale steer offers Queue when the former driver is still the holder",
    { driver: me, sendState: { kind: "stale" } },
    { send: "queue", sendStatus: "Turn ended" },
  ],
  [
    "refused send offers Queue when still allowed",
    { driver: null, sendState: { kind: "refused" } },
    { send: "queue", sendStatus: "Send refused" },
  ],
  [
    "refusal after revocation offers Ask to drive",
    { role: "viewer", sendState: { kind: "refused" } },
    { send: null, request: "ask", sendStatus: "Send refused" },
  ],
  [
    "an outstanding send is saving",
    { sendState: { kind: "submitting" } },
    { submitting: true, sendStatus: "Saving" },
  ],
  [
    "saved send has one label",
    { sendState: { kind: "saved" } },
    { submitting: false, sendStatus: "Saved" },
  ],
  [
    "delivered send has one label",
    { sendState: { kind: "with-agent" } },
    { sendStatus: "With the agent" },
  ],
  [
    "uncertain delivery has one label",
    { sendState: { kind: "in-doubt" } },
    { sendStatus: "Delivery in doubt" },
  ],
];
test.each(cases)("%s", (_label, changes, expected) => {
  expect(composerControlModel({ ...base, ...changes })).toMatchObject(expected);
});
