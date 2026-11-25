import * as Effect from "effect/Effect";
import { readConfig } from "./config";
import { startRelayServer } from "./server";

if (import.meta.main) {
  await Effect.runPromise(
    Effect.acquireUseRelease(
      Effect.sync(() => startRelayServer(readConfig(process.env))),
      () =>
        Effect.callback<void>((resume) => {
          const shutdown = () => resume(Effect.void);
          process.once("SIGINT", shutdown);
          process.once("SIGTERM", shutdown);
          return Effect.sync(() => {
            process.off("SIGINT", shutdown);
            process.off("SIGTERM", shutdown);
          });
        }),
      (server) => Effect.promise(server.stop),
    ),
  );
}
