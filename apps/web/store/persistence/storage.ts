import type { OutboxEnqueueFn, OutboxEntry } from "@platform/engine";
import type { Patch } from "mutative";
import type { PendingMessages } from "../pendingMessageJournal";

export type CachedConversation = {
  messages: any[];
  pagination: any;
  latestTimestamp: number;
  // Present when the navigator list was persisted for this conversation.
  userMessages?: any[];
};

export type CachedDocDetailRef = {
  _id: string;
  workspace?: string;
  cachedAt?: number | null;
};

export type CacheStorage = {
  loadCache(
    keys?: readonly string[],
    context?: Record<string, unknown>,
  ): Promise<Record<string, any> | null>;
  loadPaintCache(): Promise<Record<string, any> | null>;
  loadPaintCacheSync?(): Record<string, any> | null;
  setHydrating(hydrating: boolean): void;
  writePatches(patches: Patch[], state: object): void | Promise<void>;
  flushPersistence(): Promise<void>;
  loadConversationMessages(
    conversationId: string,
  ): Promise<CachedConversation | null>;
  writeConversationMessages(
    conversationId: string,
    messages: unknown[],
    pagination: unknown,
  ): void;
  writeConversationUserMessages(
    conversationId: string,
    messages: unknown[],
  ): void;
  enqueueDispatch: OutboxEnqueueFn;
  removeDispatch(id: string): void | Promise<void>;
  loadOutbox(): Promise<OutboxEntry[]>;
  outboxAccountId(): string | null;
  persistPendingMessageChanges(
    before: PendingMessages,
    after: PendingMessages,
    ownerId?: string,
  ): void;
  purgeLocalCache(options?: {
    keepPendingInputFor?: string | null;
    reason?: string;
    detail?: Record<string, unknown>;
  }): Promise<void>;
  deleteInvalidatedDocDetails?(
    ids: readonly string[],
    current: (id: string) => boolean,
    archive?: { accountId: string; dispatchedAt: number },
  ): Promise<string[]>;
  readCachedDocDetails?(): Promise<CachedDocDetailRef[]>;
  persistedDocDetailWorkspace?(id: string): string | undefined;
  compactPersistedDocDetails?(ids: readonly string[]): void;
};
