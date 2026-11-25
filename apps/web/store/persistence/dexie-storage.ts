export { persistPendingMessageChanges } from "./pendingInputJournal";
export {
  flushPersistence,
  writePatchesToIDB as writePatches,
} from "./collection-writer";
export { setHydrating } from "./hydration";
export { loadCache } from "./boot-loader";
export {
  loadConversationMessages,
  writeConversationMessages,
  writeConversationUserMessages,
} from "./message-cache";
export {
  enqueueDispatch,
  outboxAccountId,
  loadOutbox,
  removeDispatch,
} from "./outbox";
export { purgeLocalCache } from "./purge";

export async function loadPaintCache(): Promise<null> {
  return null;
}
