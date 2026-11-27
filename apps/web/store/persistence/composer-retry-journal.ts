import { withoutSecrets } from "@codecast/secrets/secretShapes";
import { authPrincipal } from "../../lib/authPrincipal";
import type { ComposerRetry } from "../steer-composer-state";
import { db } from "./db";
import { _hydrating } from "./hydration";
import { persistenceOwned } from "./ownership";

export const COMPOSER_RETRY_PREFIX = "composerRetry:v1:";

function conversationPrefix(viewer: string, conversation: string) {
  return `${COMPOSER_RETRY_PREFIX}${viewer}:${conversation}:`;
}

function safeContent<T extends { text: string; typedWords?: string }>(
  content: T,
): T {
  return {
    ...content,
    text: withoutSecrets(content.text),
    ...(content.typedWords !== undefined && {
      typedWords: withoutSecrets(content.typedWords),
    }),
  };
}

export function safeRetry(retry: ComposerRetry): ComposerRetry {
  return {
    ...retry,
    payload: safeContent(retry.payload),
    command: retry.command && safeContent(retry.command),
  };
}

function owned(viewer: string) {
  return authPrincipal.current() === viewer && persistenceOwned();
}

export async function flushDraftPersistence(
  viewer: string,
  conversation: string,
  id: string,
  retry?: ComposerRetry,
): Promise<boolean> {
  if (!owned(viewer) || (retry && _hydrating)) return false;
  const key = conversationPrefix(viewer, conversation) + id;
  try {
    if (retry) await db.meta.put({ key, value: safeRetry(retry) });
    else await db.meta.delete(key);
    return owned(viewer);
  } catch {
    return false;
  }
}

export async function loadComposerRetries(
  viewer: string,
  conversation: string,
): Promise<ComposerRetry[]> {
  if (authPrincipal.current() !== viewer) return [];
  const prefix = conversationPrefix(viewer, conversation);
  try {
    const rows = await db.meta.where("key").startsWith(prefix).toArray();
    return authPrincipal.current() === viewer
      ? rows.map(({ value }) => value)
      : [];
  } catch {
    return [];
  }
}
