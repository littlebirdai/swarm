import type { InboxStoreState } from "./inboxStore";
import { asyncAction } from "./mutativeMiddleware";
import { stampSessionCommand } from "./sessionCommandStamp";

export type ForcedMoveActions = {
  forceSessionMove: (
    requestId: string,
    conversationId: string,
    epoch: number,
    deviceId: string,
    label: string,
    acknowledged: true,
    retryFailedMove?: { move_id: string; revision: number },
  ) => Promise<string | undefined>;
};

export const forcedMoveActions = {
  forceSessionMove: asyncAction(function (
    this: InboxStoreState,
    requestId: string,
    conversationId: string,
    epoch: number,
    deviceId: string,
    label: string,
    _acknowledged: true,
    _retryFailedMove?: { move_id: string; revision: number },
  ) {
    stampSessionCommand(this, {
      _id: requestId,
      conversation_id: conversationId,
      kind: "force-move",
      command: "force_move",
      to_device_id: deviceId,
      to_label: label,
      source_epoch: epoch,
    });
  }),
};
