import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EdgeSteeringHost } from "@codecast/edge-client";
import {
  parsePermitsNextResponse,
  type PermitsNextRequest,
} from "@codecast/edge-contract";
import { atomicWriteFile } from "../atomicWrite.js";

export function daemonSteerJournal(
  directory: string,
): EdgeSteeringHost["journal"] {
  const file = ({
    session,
    run,
  }: Pick<PermitsNextRequest, "session" | "run">) => {
    const digest = createHash("sha256").update(session).digest("hex");
    return join(directory, `${digest}.${run}.steer`);
  };
  return {
    async load(scope, signal) {
      signal.throwIfAborted();
      const filePath = file(scope);
      let contents: string;
      try {
        contents = readFileSync(filePath, "utf8");
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return undefined;
        throw error;
      }
      const invalid = () => new Error(`Invalid steer journal at ${filePath}`);
      const state: unknown = JSON.parse(contents);
      if (
        !state ||
        typeof state !== "object" ||
        !("version" in state) ||
        state.version !== 1 ||
        !("fences" in state) ||
        !Array.isArray(state.fences) ||
        !("handovers" in state) ||
        !Array.isArray(state.handovers)
      )
        throw invalid();

      const fences = state.fences.map((record: unknown) => {
        const parsed = parsePermitsNextResponse(record);
        if (
          !parsed.ok ||
          parsed.value.status !== "takeover_fence" ||
          parsed.value.session !== scope.session ||
          parsed.value.run !== scope.run
        )
          throw invalid();
        return parsed.value;
      });
      const handovers = state.handovers.map((record: unknown) => {
        if (!record || typeof record !== "object") throw invalid();
        const parsed = parsePermitsNextResponse({
          ...record,
          status: "permit",
          state: "started",
          input: [],
        });
        if (
          !parsed.ok ||
          parsed.value.status !== "permit" ||
          parsed.value.intent !== "steer" ||
          parsed.value.session !== scope.session ||
          parsed.value.run !== scope.run
        )
          throw invalid();
        const { status, state, input, ...handover } = parsed.value;
        return handover;
      });
      return { fences, handovers };
    },
    async save(scope, state, signal) {
      signal.throwIfAborted();
      atomicWriteFile(
        file(scope),
        `${JSON.stringify({ version: 1, ...state })}\n`,
        {
          mode: 0o600,
        },
      );
    },
  };
}
