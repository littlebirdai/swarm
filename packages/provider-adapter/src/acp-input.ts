import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { extname } from "node:path";
import type { EdgeJson, PromptOpened } from "@codecast/edge-contract";
import type { SteerRequest } from "@codecast/provider-contract";
import { withoutSecrets } from "@codecast/secrets/secretShapes";
import type { Permission } from "./acp-schema";

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
) {
  const blocks = [];
  let remaining = maxImageBytes;
  for (const item of input) {
    if (item.type === "text") {
      blocks.push(item);
      continue;
    }
    const mimeType = imageTypes[extname(item.path).toLowerCase()];
    if (!mimeType) throw new Error("Unsupported ACP image type");

    const image = await open(
      item.path,
      constants.O_RDONLY | constants.O_NONBLOCK,
    );
    try {
      const stat = await image.stat();
      const { size } = stat;
      if (!stat.isFile() || size === 0 || size > remaining)
        throw new Error(
          "ACP images must be nonempty regular files within the total image size limit",
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
        if (!bytesRead) throw new Error("ACP image changed while reading");
        offset += bytesRead;
      }
      remaining -= size;
      blocks.push({ type: "image", mimeType, data: bytes.toString("base64") });
    } finally {
      await image.close();
    }
  }
  return blocks;
}

function displayText(text: string | null | undefined, limit: number) {
  return text
    ? withoutSecrets(text)
        .replace(/[\r\n\u0085\u2028\u2029]+/gu, " ")
        .trim()
        .slice(0, limit)
        .trimEnd() || undefined
    : undefined;
}

export function permissionDisplay({
  options,
  toolCall,
}: typeof Permission.Type) {
  const offered: NonNullable<PromptOpened["options"]> = [];
  const ids = new Set<string>();
  for (const { optionId: id, name, kind } of options) {
    if (!id.trim() || id.length > 128 || ids.has(id)) continue;
    ids.add(id);
    offered.push({
      id,
      label: displayText(name, 128) ?? `Option ${offered.length + 1}`,
      ...(kind === "allow_once" ||
      kind === "allow_always" ||
      kind === "reject_once" ||
      kind === "reject_always"
        ? { kind }
        : {}),
    });
    if (offered.length === 16) break;
  }
  const toolCallId = toolCall?.toolCallId;
  const name = displayText(toolCall?.title, 128);
  const summary = displayText(toolCall?.title, 500);
  return {
    ...(toolCallId?.trim() && toolCallId.length <= 256
      ? { tool_call_id: toolCallId }
      : {}),
    ...(name ? { tool_name: name } : {}),
    ...(summary ? { summary } : {}),
    ...(offered.length ? { options: offered } : {}),
  };
}

export function permissionChoice(
  answer: EdgeJson,
  options: typeof Permission.Type.options,
  offered: PromptOpened["options"],
) {
  if (answer === null) return null;
  if (typeof answer !== "object" || Array.isArray(answer)) return undefined;
  if (Object.hasOwn(answer, "option_id")) {
    const { option_id } = answer;
    return Object.keys(answer).length === 1
      ? offered?.find(({ id }) => id === option_id)?.id
      : undefined;
  }
  const { behavior, updatedPermissions } = answer;
  const remembered =
    Array.isArray(updatedPermissions) && updatedPermissions.length > 0;
  const kinds =
    behavior === "allow"
      ? remembered
        ? ["allow_always", "allow_once"]
        : ["allow_once", "allow_always"]
      : behavior === "deny"
        ? ["reject_once", "reject_always"]
        : [];
  for (const kind of kinds) {
    const option = options.find((option) => option.kind === kind);
    if (option) return option.optionId;
  }
  return undefined;
}
