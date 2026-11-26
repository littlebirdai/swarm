import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import type { EdgeSteeringHost } from "@codecast/edge-client";
import {
  parsePermitsNextResponse,
  type PermitsNextRequest,
} from "@codecast/edge-contract";
import { atomicWriteFile } from "../atomicWrite.js";

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function removeJournal(filePath: string, directory: string): void {
  try {
    unlinkSync(filePath);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }

  try {
    const fd = openSync(directory, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {}
}

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
        if (isMissing(error)) return undefined;
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
        if (!record || typeof record !== "object") throw invalid();
        const acknowledged =
          "acknowledged" in record ? record.acknowledged : undefined;
        if (acknowledged !== undefined && acknowledged !== true)
          throw invalid();
        if (
          !parsed.ok ||
          parsed.value.status !== "takeover_fence" ||
          parsed.value.session !== scope.session ||
          parsed.value.run !== scope.run
        )
          throw invalid();
        return acknowledged === true
          ? { ...parsed.value, acknowledged: true as const }
          : parsed.value;
      });
      const handovers = state.handovers.map((record: unknown) => {
        if (
          !record ||
          typeof record !== "object" ||
          Array.isArray(record) ||
          "status" in record ||
          "state" in record ||
          "input" in record
        )
          throw invalid();
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
      const filePath = file(scope);
      if (!state.fences.length && !state.handovers.length) {
        removeJournal(filePath, directory);
        return;
      }
      atomicWriteFile(
        filePath,
        `${JSON.stringify({ version: 1, ...state })}\n`,
        {
          mode: 0o600,
        },
      );
    },
  };
}
