import path from "node:path";

export const LINT_ROOT = path.resolve(import.meta.dir, "../..");

type OxlintDiagnostic = {
  filename?: string;
  code?: string;
  severity: "error" | "warning";
  message: string;
  labels?: { span: { line: number } }[];
};

type OxlintReport = {
  diagnostics: OxlintDiagnostic[];
  number_of_files: number;
};

export function parseOxlintReport(stdout: string): OxlintReport {
  const report = JSON.parse(stdout);
  if (!Array.isArray(report?.diagnostics) || !Number.isSafeInteger(report.number_of_files)) {
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
  const rule = code?.replace(/^([^()]+)\(([^()]+)\)$/, "$1/$2") ?? "oxlint/parse";
  return {
    file: filename ? path.relative(LINT_ROOT, path.resolve(LINT_ROOT, filename)).split(path.sep).join("/") : null,
    line: labels?.[0]?.span.line ?? 1,
    rule,
    message,
    severity,
  };
}
