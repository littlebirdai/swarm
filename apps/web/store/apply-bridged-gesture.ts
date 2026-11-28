import type { GestureMessage } from "./gestureBridge";
import { useInboxStore } from "./inboxStore";

/**
 * A sibling window's gesture, landed in this window. Follow state is
 * ephemeral window state, not a row: it never enters the draft, so it takes
 * its own path to the setter.
 */
export function applyBridgedGesture(msg: GestureMessage): void {
  if (msg.kind === "follow") {
    useInboxStore
      .getState()
      .setFollowLeader(msg.leaderId, { fromBridge: true });
    return;
  }
  useInboxStore.getState().applyGestureBridge(msg);
}
