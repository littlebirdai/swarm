import type { Message } from "../store/inboxStore";

export const id = (index: number) => `j${String(index).padStart(31, "0")}`;
export const now = Date.now();
export const session = (index: number) => ({
  _id: id(index),
  session_id: `session-${index}`,
  title: "Budget session",
  updated_at: now - index,
});

export const budgetMessages = (conversation: number): Message[] =>
  Array.from({ length: 200 }, (_, index) => ({
    _id: `message-${index}`,
    timestamp: index + 1,
    role: "assistant",
    content: `Résumé ${conversation} ${index} ${"word ".repeat(16)}`,
    ...(index === 100
      ? { images: [{ data: "a".repeat(4096), mediaType: "image/png" }] }
      : {}),
  }));

export const fixtureSizes = {
  sessions: 1300,
  conversations: 1300,
  docDetails: 220,
  taskComments: 1600,
  pullRequestDetails: 24,
  deployReach: 320,
  runGraphs: 60,
  deployDetails: 70,
  externalEvents: 2100,
  settingsData: 2,
  mySends: 10100,
} as const;

export const retainedRows = (key: string, size: number) =>
  Array.from({ length: size }, (_, index) => ({
    ...session(index),
    _cachedAt: now - index,
    timestamp: now - index,
    ...(key === "taskComments" ? { comments: [] } : {}),
    ...(key === "settingsData"
      ? { _id: index === 0 ? "team:preferences" : "team:teamMembers" }
      : {}),
  }));

export const budgetTail = (): Message[] =>
  Array.from({ length: 200 }, (_, index) => ({
    _id: `message-${index}`,
    timestamp: index + 1,
    role: "assistant",
    content: `Message ${index}`,
  }));
