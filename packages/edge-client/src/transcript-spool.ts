import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import {
  parseTranscriptAppendRequest,
  type TranscriptAppendRequest,
} from "@codecast/edge-contract";

export interface TranscriptSpool {
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
    async read() {
      const text = await readFile(path, "utf8").catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        },
      );
      if (text === null) return null;
      const parsed = parseTranscriptAppendRequest(JSON.parse(text));
      if (!parsed.ok) throw parsed.error;
      return parsed.value;
    },
    async save(batch) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const fd = await open(temporary, "w", 0o600);
      try {
        await fd.writeFile(JSON.stringify(batch));
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
