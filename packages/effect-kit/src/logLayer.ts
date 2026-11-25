import { formatStructured, layer, make } from "effect/Logger";
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
  return layer([
    make((event) => {
      const { message, cause } = formatStructured.log(event);
      const parts = Array.isArray(message) ? message : [message];
      const text = parts
        .map((part) => (typeof part === "string" ? part : inspect(part)))
        .join(" ");
      log(
        cause ? [text, cause].filter(Boolean).join("\n") : text,
        daemonLevels[event.logLevel],
      );
    }),
  ]);
}
