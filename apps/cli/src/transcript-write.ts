import type { TranscriptUplinkClient } from "@codecast/edge-client";
import {
  fitsTranscriptUplink,
  type TranscriptAppendWrite,
  type TranscriptAppendResult,
} from "@codecast/edge-contract";
import { argumentValidationProblem } from "@codecast/convex-errors/convexErrors";
import {
  checkTranscriptDeadline,
  outsideTranscriptDeadline,
} from "./workers/ingestDeadline.js";

export type SyncTranscriptUplink = Pick<
  TranscriptUplinkClient,
  "submit" | "waitForReplay"
>;

function isStartupReadFailure(
  error: unknown,
): error is Error & { startupReadFailure: true; spoolPath?: string } {
  return (
    error instanceof Error &&
    (error as { startupReadFailure?: boolean }).startupReadFailure === true
  );
}

export function attachTranscriptUplink(
  sync: {
    setTranscriptUplink(
      uplink: SyncTranscriptUplink | undefined,
      expected?: SyncTranscriptUplink,
    ): void;
  },
  opening: Promise<TranscriptUplinkClient>,
  report: (error: Error) => void,
): void {
  let detached = false;
  const started = opening
    .then(async (uplink) => {
      await uplink.start();
      return true;
    })
    .catch((error: unknown) => {
      if (!isStartupReadFailure(error)) {
        report(error instanceof Error ? error : new Error(String(error)));
        return false;
      }
      detached = true;
      sync.setTranscriptUplink(undefined, binding);
      const path = error.spoolPath;
      report(
        new Error(
          `${error.message}. Transcript writes fell back to legacy${path ? `. Spool left for inspection at ${path}` : ""}`,
          { cause: error.cause },
        ),
      );
      void opening.then((uplink) => uplink.close()).catch(() => {});
      return false;
    });
  const run = async <T>(
    call: (uplink: TranscriptUplinkClient) => Promise<T>,
    legacy: T,
  ) => {
    try {
      return await call(await opening);
    } catch (error) {
      if (
        detached ||
        (isStartupReadFailure(error) && !(await started) && detached)
      )
        return legacy;
      throw error;
    }
  };
  const binding: SyncTranscriptUplink = {
    submit: (write) =>
      run((uplink) => uplink.submit(write), { status: "legacy" }),
    waitForReplay: (id) => run((uplink) => uplink.waitForReplay(id), undefined),
  };
  sync.setTranscriptUplink(binding);
}

export function startDaemonTranscriptUplink(
  sync: {
    setApiToken(token: string): void;
    setTranscriptUplink(
      uplink: SyncTranscriptUplink | undefined,
      expected?: SyncTranscriptUplink,
    ): void;
    replayTranscriptWrite(
      write: TranscriptAppendWrite,
      bearer: string,
    ): Promise<TranscriptAppendResult>;
  },
  options: {
    convexUrl: string;
    account: string | undefined;
    readConfig: () => {
      user_id?: string;
      convex_url?: string;
      auth_token?: string;
    } | null;
    logError: (message: string, error: Error) => void;
  },
) {
  const { convexUrl, account, readConfig, logError } = options;
  if (process.env.CODECAST_EDGE_TRANSCRIPT_UPLINK_V1 !== "1" || !account)
    return undefined;
  const opening = import("./daemon-transcript-uplink.js").then(
    ({ openTranscriptUplink }) =>
      openTranscriptUplink(sync, {
        convexUrl,
        account,
        bearer: () => {
          const latest = readConfig();
          if (
            latest?.user_id !== account ||
            (latest?.convex_url || process.env.CONVEX_URL) !== convexUrl
          )
            return null;
          if (latest?.auth_token) sync.setApiToken(latest.auth_token);
          return latest?.auth_token ?? null;
        },
      }),
  );
  attachTranscriptUplink(sync, opening, (error) =>
    logError("Transcript uplink startup failed", error),
  );
  return opening;
}

export function withoutDeliveryIds<T extends { delivery_ids?: unknown }>(
  message: T,
): Omit<T, "delivery_ids"> {
  const { delivery_ids: _ids, ...rest } = message;
  return rest;
}

export async function tryTranscriptUplink(
  uplink: SyncTranscriptUplink | undefined,
  conversationId: string,
  batch: Array<{ message_uuid?: string; delivery_ids?: unknown }>,
  echoes: boolean,
) {
  if (!uplink || !batch.every((message) => message.message_uuid)) return;
  const write = {
    conversation_id: conversationId,
    messages: JSON.parse(
      JSON.stringify(echoes ? batch : batch.map(withoutDeliveryIds)),
    ),
    ...(echoes ? { echo_ids: true } : {}),
  };
  if (!fitsTranscriptUplink(write)) return;

  checkTranscriptDeadline();
  const result = await uplink.submit(write);
  if (result.status === "refused")
    throw new Error("Transcript write refused for this conversation");
  if (result.status === "applied") return result;
}

export async function replayTranscriptWrite(
  write: TranscriptAppendWrite,
  mutate: (
    payload: TranscriptAppendWrite,
  ) => Promise<{ inserted: number; ids: string[] }>,
): Promise<TranscriptAppendResult> {
  const send = (payload: TranscriptAppendWrite) =>
    outsideTranscriptDeadline(() => mutate(payload));
  try {
    let result;
    try {
      result = await send(write);
    } catch (error) {
      if (
        !write.echo_ids ||
        !/echo_ids|delivery_ids/.test(argumentValidationProblem(error) ?? "")
      )
        throw error;
      result = await send({
        conversation_id: write.conversation_id,
        messages: write.messages.map(withoutDeliveryIds),
      });
    }
    return { status: "applied", ...result };
  } catch (error) {
    if (
      argumentValidationProblem(error) ||
      /Conversation not found|can only add messages to your own conversations|hosted conversation's transcript/.test(
        error instanceof Error ? error.message : "",
      )
    )
      return { status: "refused" };
    throw error;
  }
}
