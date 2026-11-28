import { join } from "node:path";
import {
  createEdgeClient,
  type EdgeClient,
  type EdgeSteerHandover,
  type EdgeSteerOutcome,
  type EdgeSteerPermit,
  type EdgeSteerRecovery,
  type EdgeTransport,
} from "@codecast/edge-client";
import type { PermitsNextRequest } from "@codecast/edge-contract";
import { defaultConfigDir } from "../config/configDir.js";
import { daemonSteerJournal } from "./daemon-steer-journal.js";

type PreparedInput = readonly (
  | { type: "text"; text: string }
  | { type: "local-image"; path: string }
)[];

interface DaemonSteerAgent {
  runningTurn(run: PermitsNextRequest): string | null;
  prepareInput(
    permit: EdgeSteerPermit,
    signal: AbortSignal,
  ): Promise<PreparedInput>;
  steer(
    request: {
      session: string;
      expected: { run: number; fencing_token: string; turn: string };
      delivery_id: string;
      authors: readonly EdgeSteerPermit["sender"][];
      input: PreparedInput;
    },
    signal: AbortSignal,
  ): Promise<EdgeSteerOutcome>;
  recover(
    handover: EdgeSteerHandover,
    signal: AbortSignal,
  ): Promise<EdgeSteerRecovery>;
}

export function createDaemonEdgeClient(options: {
  transport: EdgeTransport;
  agent?: DaemonSteerAgent;
  journalDirectory?: string;
}): EdgeClient {
  const { transport, agent } = options;
  if (!agent) return createEdgeClient({ transport });

  return createEdgeClient({
    transport,
    steering: {
      runningTurn: (run) => agent.runningTurn(run),
      prepare: async (permit, signal) => {
        const input = await agent.prepareInput(permit, signal);
        return (handoffSignal) =>
          agent.steer(
            {
              session: permit.session,
              expected: {
                run: permit.run,
                fencing_token: permit.fencing_token,
                turn: permit.expected.turn,
              },
              delivery_id: permit.delivery_id,
              authors: [permit.sender],
              input,
            },
            handoffSignal,
          );
      },
      recover: (handover, signal) => agent.recover(handover, signal),
      journal: daemonSteerJournal(
        options.journalDirectory ??
          join(defaultConfigDir(), "execution-journal"),
      ),
    },
  });
}
