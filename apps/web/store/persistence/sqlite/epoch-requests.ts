import type { AuthPrincipalTracker } from "@platform/auth/web";
import {
  epochId,
  type CacheEpoch,
  type SqliteWorkerOp,
  type SqliteWorkerPayloads,
  type SqliteWorkerResults,
} from "./protocol";
import { WorkerRpcError, type WorkerConnection } from "./worker-connection";

export type EpochRequests = {
  send<K extends SqliteWorkerOp>(
    epoch: CacheEpoch,
    principal: string,
    op: K,
    payload: SqliteWorkerPayloads[K],
  ): Promise<SqliteWorkerResults[K]>;
};

export function createEpochRequests(deps: {
  connection: Pick<WorkerConnection, "send" | "activeEpoch">;
  auth: Pick<AuthPrincipalTracker, "current" | "epoch">;
  isOpen: () => boolean;
}): EpochRequests {
  const { connection, auth, isOpen } = deps;
  return {
    async send(epoch, principal, op, payload) {
      const authEpoch = auth.epoch();
      const result = await connection.send(epoch, principal, op, payload);
      const active = connection.activeEpoch();
      if (
        !isOpen() ||
        auth.current() !== principal ||
        auth.epoch() !== authEpoch ||
        !active ||
        epochId(active) !== epochId(epoch)
      )
        throw new WorkerRpcError(
          "closed",
          `SQLite ${op} answered for an epoch that is no longer active`,
        );
      return result;
    },
  };
}
