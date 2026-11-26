import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { extname } from "node:path";
import type { SteerRequest } from "@codecast/provider-contract";

const maxImageBytes = 16 * 1024 * 1024;
const imageTypes: Readonly<Record<string, string>> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

export async function promptBlocks(
  input: SteerRequest["input"],
  signal: AbortSignal,
  name: string,
) {
  const blocks = [];
  let remaining = maxImageBytes;
  for (const item of input) {
    if (item.type === "text") {
      blocks.push(item);
      continue;
    }
    const mimeType = imageTypes[extname(item.path).toLowerCase()];
    if (!mimeType) throw new Error(`Unsupported ${name} image type`);

    const image = await open(
      item.path,
      constants.O_RDONLY | constants.O_NONBLOCK,
    );
    try {
      const stat = await image.stat();
      const { size } = stat;
      if (!stat.isFile() || size === 0 || size > remaining)
        throw new Error(
          `${name} images must be nonempty regular files within the total image size limit`,
        );
      signal.throwIfAborted();
      const bytes = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) {
        signal.throwIfAborted();
        const { bytesRead } = await image.read(
          bytes,
          offset,
          size - offset,
          offset,
        );
        if (!bytesRead) throw new Error(`${name} image changed while reading`);
        offset += bytesRead;
      }
      remaining -= size;
      blocks.push({
        type: "image" as const,
        mimeType,
        data: bytes.toString("base64"),
      });
    } finally {
      await image.close();
    }
  }
  return blocks;
}
