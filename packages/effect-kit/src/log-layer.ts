import { pretty } from "effect/Cause";
import { layer, make, tracerLogger } from "effect/Logger";
import { CurrentLogAnnotations, CurrentLogSpans } from "effect/References";
import type { LogLevel } from "effect/LogLevel";
import { inspect } from "node:util";

const daemonLevels = {
  All: "debug",
  Trace: "debug",
  Debug: "debug",
  Info: "info",
  Warn: "warn",
  Error: "error",
  Fatal: "error",
  None: "debug",
} as const satisfies Record<LogLevel, string>;

export function logLayer(
  log: (message: string, level: "debug" | "info" | "warn" | "error") => void,
) {
  let logging = false;
  return layer([
    tracerLogger,
    make((event) => {
      if (logging) return;
      logging = true;
      try {
        const { cause, date, fiber, message } = event;
        const annotations = fiber.getRef(CurrentLogAnnotations);
        const spans = Object.fromEntries(
          fiber
            .getRef(CurrentLogSpans)
            .map(([label, started]) => [label, date.getTime() - started]),
        );
        const parts = Array.isArray(message) ? message : [message];
        const text = parts
          .map((part) => (typeof part === "string" ? part : inspect(part)))
          .join(" ");
        const context = [
          Object.keys(annotations).length
            ? `annotations=${inspect(annotations)}`
            : "",
          Object.keys(spans).length ? `spans=${inspect(spans)}` : "",
        ].filter(Boolean);
        const line = [text, ...context].filter(Boolean).join(" ");
        log(
          [line, cause.reasons.length ? pretty(cause) : ""]
            .filter(Boolean)
            .join("\n"),
          daemonLevels[event.logLevel],
        );
      } catch (error) {
        try {
          process.stderr.write(
            `Effect log callback failed: ${inspect(error, { customInspect: false })}\n`,
          );
        } catch {}
      } finally {
        logging = false;
      }
    }),
  ]);
}
