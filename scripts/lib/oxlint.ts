import path from "node:path";

export const LINT_ROOT = path.resolve(import.meta.dir, "../..");

export type OxlintDiagnostic = {
  filename?: string;
  code?: string;
  severity: "error" | "warning";
  message: string;
  labels?: { span: { line: number; offset: number; length: number } }[];
};

export function diagnosticSpanText(
  diagnostic: OxlintDiagnostic,
  source: Buffer,
): string | undefined {
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
  return lintSourceText(source.subarray(offset, offset + length)) || undefined;
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
