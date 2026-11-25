import path from "node:path";

export const LINT_ROOT = path.resolve(import.meta.dir, "../..");

export type OxlintDiagnostic = {
  filename?: string;
  code?: string;
  severity: "error" | "warning";
  message: string;
  labels?: { span: { line: number; offset: number; length: number } }[];
};

export type DiagnosticLines = {
  text: string;
  start?: number;
  previous?: string;
  next?: string;
};

function adjacentLine(source: Buffer, boundary: number, direction: -1 | 1) {
  while (boundary >= 0 && boundary < source.length) {
    const found =
      direction === -1
        ? boundary > 0
          ? source.lastIndexOf(10, boundary - 1)
          : -1
        : source.indexOf(10, boundary + 1);
    const edge = found === -1 ? (direction === -1 ? -1 : source.length) : found;
    const start = Math.min(boundary, edge) + 1;
    const end = Math.max(boundary, edge);
    const line = source.toString("utf8", start, end).trim();
    if (/[\p{L}\p{N}]/u.test(line)) return line;
    boundary = edge;
  }
}

export function diagnosticLines(
  diagnostic: OxlintDiagnostic,
  source: Buffer,
): DiagnosticLines | undefined {
  const span = diagnostic.labels?.[0]?.span;
  if (!span) return;
  const { offset, length } = span;
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length <= 0 ||
    offset + length > source.length
  ) {
    return;
  }
  const start = offset ? source.lastIndexOf(10, offset - 1) + 1 : 0;
  const newline = source.indexOf(10, offset + length - 1);
  const end = newline === -1 ? source.length : newline;
  const text = lintSourceText(source.subarray(start, end));
  if (!text.trim()) return;
  return {
    text,
    start,
    previous: adjacentLine(source, start - 1, -1),
    next: adjacentLine(source, end, 1),
  };
}

export function lintSourceText(source: Buffer): string {
  return source
    .toString("utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .join("\n");
}

type OxlintReport = {
  diagnostics: OxlintDiagnostic[];
  number_of_files: number;
};

export function parseOxlintReport(stdout: string): OxlintReport {
  const report = JSON.parse(stdout);
  if (
    !Array.isArray(report?.diagnostics) ||
    !Number.isSafeInteger(report.number_of_files)
  ) {
    throw new Error("Oxlint returned an invalid JSON report.");
  }
  return report;
}

export function oxlintCommand(args: string[]) {
  return [
    path.join(LINT_ROOT, "node_modules/.bin/oxlint"),
    "--disable-nested-config",
    "--format",
    "json",
    ...args,
  ];
}

export function lintLocation(diagnostic: OxlintDiagnostic) {
  const { filename, code, message, severity, labels } = diagnostic;
  const rule =
    code?.replace(/^([^()]+)\(([^()]+)\)$/, "$1/$2") ?? "oxlint/parse";
  return {
    file: filename
      ? path
          .relative(LINT_ROOT, path.resolve(LINT_ROOT, filename))
          .split(path.sep)
          .join("/")
      : null,
    line: labels?.[0]?.span.line ?? 1,
    rule,
    message,
    severity,
  };
}
