import type { ResumeSpec, StartSpec } from "@codecast/provider-contract";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Initialize, ThreadReply, type OpenOptions } from "./app-server-schema";
import { processError, AdapterError } from "./provider-process";

export const initializeAppServer = Effect.fn("app-server.initialize")(
  function* (
    spec: StartSpec | ResumeSpec,
    settings: typeof OpenOptions.Type,
    version: string,
    roundTrip: (
      method: string,
      params: object,
    ) => Effect.Effect<unknown, AdapterError>,
    notifyInitialized: Effect.Effect<void, AdapterError>,
  ) {
    const initialized = yield* roundTrip("initialize", {
      clientInfo: {
        name: "codecast",
        title: "Codecast Daemon",
        version: "1.0.0",
      },
      capabilities: { experimentalApi: true },
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Initialize)),
      Effect.mapError((cause) =>
        processError(
          "initialize-failed",
          cause instanceof AdapterError
            ? cause.message
            : "Invalid app-server initialize response",
          cause,
        ),
      ),
    );
    if (
      initialized.userAgent.match(/\/(\d+\.\d+\.\d+)(?:\s|$)/u)?.[1] !== version
    ) {
      return yield* processError(
        "agent-version",
        "Codex app-server reported a different version",
      );
    }
    yield* notifyInitialized;
    const resuming = "checkpoint" in spec;
    const thread = yield* roundTrip(
      resuming ? "thread/resume" : "thread/start",
      {
        ...settings,
        cwd: spec.cwd,
        ...(resuming ? { threadId: spec.checkpoint } : {}),
      },
    ).pipe(
      Effect.flatMap((reply) =>
        Schema.decodeUnknownEffect(ThreadReply)(reply).pipe(
          Effect.mapError((cause) =>
            processError(
              "invalid-thread",
              "Invalid app-server thread response",
              cause,
            ),
          ),
        ),
      ),
    );
    if (resuming && thread.thread.id !== spec.checkpoint)
      return yield* processError(
        "checkpoint-mismatch",
        "Codex app-server resumed a different thread",
      );
    return thread;
  },
);
