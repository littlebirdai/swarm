const NORMALIZED_LIMIT = 4096;
const normalized = new Map<string, string>();
export function normText(text: string): string {
  let result = normalized.get(text);
  if (result === undefined) {
    if (normalized.size >= NORMALIZED_LIMIT) normalized.clear();
    result = text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
    normalized.set(text, result);
  }
  return result;
}
