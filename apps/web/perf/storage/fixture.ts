export const ROW_COUNT = 150_000;
export const SESSION_COUNT = 1_200;
export const MESSAGE_COUNT = 200;
export const EVENT_COUNT = ROW_COUNT - SESSION_COUNT - MESSAGE_COUNT;
export const PAINT_SESSIONS = 134;
export const WRITE_ROWS = 20;
export const SQLITE_BUILD = "3.54.1-build1";

function id(prefix: string, index: number) {
  return prefix + index.toString(36).padStart(31, "0");
}

export const sessionId = (index: number) => id("s", index);
export const eventId = (index: number) => id("e", index);
export const focusId = sessionId(0);
export const liveIds = Array.from({ length: PAINT_SESSIONS }, (_, index) =>
  sessionId(index),
);

function payload(seed: number, length: number) {
  const alphabet =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";
  let state = seed + 1;
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index++) {
    state = Math.imul(state, 1664525) + 1013904223;
    bytes[index] = alphabet.charCodeAt((state >>> 16) & 63);
  }
  return new TextDecoder().decode(bytes);
}

export function eventRow(index: number, revision = 0) {
  return {
    _id: eventId(index),
    team_id: "synthetic-team",
    repository: "synthetic/store",
    plan_id: "synthetic-plan",
    kind: "push",
    created_at: 1_700_000_000_000 + index,
    title: `Synthetic event ${index}`,
    body: payload(index, 1000),
    revision,
  };
}

export const sessionRows = () =>
  Array.from({ length: SESSION_COUNT }, (_, index) => ({
    _id: sessionId(index),
    title: `Synthetic session ${index}`,
    agent: "codex",
    is_pinned: true,
    summary: payload(EVENT_COUNT + index, 2400),
  }));

export const messageRows = () =>
  Array.from({ length: MESSAGE_COUNT }, (_, position) => ({
    convId: focusId,
    messageKey: id("m", position),
    revision: "seed",
    position,
    message: {
      _id: id("m", position),
      role: "assistant",
      content: payload(EVENT_COUNT + SESSION_COUNT + position, 720),
    },
  }));

export const writeRows = (revision: number) =>
  Array.from({ length: WRITE_ROWS }, (_, index) => eventRow(index, revision));

export function check(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error(detail);
}
