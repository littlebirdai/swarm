export function codeLines(src: string): Array<{ line: string; n: number }> {
  const out: Array<{ line: string; n: number }> = [];
  src.split("\n").forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
    out.push({ line, n: i + 1 });
  });
  return out;
}
