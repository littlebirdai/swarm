import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import {
  parseTranscriptSpoolRequest,
  TRANSCRIPT_APPEND_MAX_BYTES,
  type TranscriptAppendRequest,
} from "@codecast/edge-contract";

export interface TranscriptSpool {
  readonly path?: string;
  read(): Promise<TranscriptAppendRequest | null>;
  save(batch: TranscriptAppendRequest): Promise<void>;
  clear(): Promise<void>;
}

export function fileTranscriptSpool(path: string): TranscriptSpool {
  const directory = dirname(path);
  const temporary = `${path}.tmp`;
  const syncDirectory = async () => {
    if (process.platform === "win32") return;
    const fd = await open(directory, "r");
    try {
      await fd.sync();
    } finally {
      await fd.close();
    }
  };

  return {
    path,
    async read() {
      const fd = await open(path, "r").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!fd) return null;
      const bytes = Buffer.alloc(TRANSCRIPT_APPEND_MAX_BYTES + 1);
      let length = 0;
      try {
        while (length < bytes.length) {
          const { bytesRead } = await fd.read(
            bytes,
            length,
            bytes.length - length,
            length,
          );
          if (bytesRead === 0) break;
          length += bytesRead;
        }
      } finally {
        await fd.close();
      }
      if (length > TRANSCRIPT_APPEND_MAX_BYTES)
        throw new Error("Transcript spool exceeds byte limit");
      let decoded: unknown;
      try {
        decoded = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            bytes.subarray(0, length),
          ),
        );
      } catch (cause) {
        throw new Error("Invalid transcript spool JSON or UTF-8", { cause });
      }
      const parsed = parseTranscriptSpoolRequest(decoded);
      if (!parsed.ok) throw parsed.error;
      return parsed.value;
    },
    async save(batch) {
      const body = JSON.stringify(batch);
      if (Buffer.byteLength(body) > TRANSCRIPT_APPEND_MAX_BYTES)
        throw new Error("Transcript spool exceeds byte limit");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const fd = await open(temporary, "w", 0o600);
      try {
        await fd.writeFile(body);
        await fd.sync();
      } finally {
        await fd.close();
      }
      await rename(temporary, path);
      await syncDirectory();
    },
    async clear() {
      await unlink(path);
      await syncDirectory();
    },
  };
}
