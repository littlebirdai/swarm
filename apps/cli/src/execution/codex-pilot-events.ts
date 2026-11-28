import path from "node:path";
import type { ClaimGrant } from "@codecast/edge-client";
import {
  EDGE_PROTOCOL_VERSION as v,
  parseEventsAppendResponse,
  type CanonicalEvent,
  type EdgeParseResult,
} from "@codecast/edge-contract";
import { defaultConfigDir } from "../config/configDir.js";
import {
  createTerminalEventWriter,
  TerminalEventRejected,
} from "../terminal/terminal-lifecycle.js";
import { deliveryFence } from "./codex-pilot-delivery.js";

export class CodexPilotEvents {
  private terminalEvents?: ReturnType<typeof createTerminalEventWriter>;

  constructor(
    private readonly edge: <T>(
      operation: string,
      request: object,
      parse: (input: unknown) => EdgeParseResult<T>,
      signal?: AbortSignal,
    ) => Promise<T>,
    private readonly log: (message: string) => void,
  ) {}

  prepare(claim: ClaimGrant): void {
    if (!this.terminalEvents) {
      try {
        this.terminalEvents = createTerminalEventWriter(
          claim,
          path.join(defaultConfigDir(), "terminal-lifecycle"),
          (events, abandonTerminalSeq) =>
            this.append(
              claim,
              events,
              AbortSignal.timeout(10_000),
              abandonTerminalSeq,
            ),
          (error) =>
            this.log(
              `[owned-codex] terminal event update failed: ${String(error)}`,
            ),
        );
      } catch (error) {
        this.log(
          `[owned-codex] terminal journal could not be opened: ${String(error)}`,
        );
      }
    }
  }

  appendEvent(claim: ClaimGrant, event: CanonicalEvent): Promise<void> {
    if (this.terminalEvents) return this.terminalEvents.append(event);
    return this.append(claim, [event]);
  }

  startWatching(): Promise<void> | undefined {
    return this.terminalEvents
      ?.startWatching()
      .catch((error) =>
        this.log(
          `[owned-codex] terminal event recovery failed: ${String(error)}`,
        ),
      );
  }

  close(): Promise<void> | undefined {
    return this.terminalEvents
      ?.close()
      .catch((error) =>
        this.log(
          `[owned-codex] terminal event cleanup failed: ${String(error)}`,
        ),
      );
  }

  private async append(
    claim: ClaimGrant,
    events: readonly [CanonicalEvent, ...CanonicalEvent[]],
    signal?: AbortSignal,
    abandonTerminalSeq?: number,
  ): Promise<void> {
    const response = await this.edge(
      "events.append",
      {
        v,
        batches: [
          {
            ...deliveryFence(claim),
            events,
            ...(abandonTerminalSeq === undefined
              ? {}
              : { abandon_terminal_seq: abandonTerminalSeq }),
          },
        ],
      },
      parseEventsAppendResponse,
      signal,
    );
    const result = "results" in response ? response.results[0] : undefined;
    if (
      result?.status === "conflict" &&
      result.session === claim.session &&
      result.seq === events[0].seq
    )
      throw new TerminalEventRejected("Owned Codex event append conflicted");
    if (
      result?.status !== "appended" ||
      result.session !== claim.session ||
      result.through_seq !== (events.at(-1) ?? events[0]).seq
    )
      throw new Error("Owned Codex event sequence was not confirmed");
  }
}
