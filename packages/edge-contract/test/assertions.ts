import { expect } from "bun:test";
import {
  EdgeParseError,
  type EdgeParseErrorCode,
  type EdgeParseResult,
} from "@codecast/edge-contract";
export function expectParsed(result: EdgeParseResult<unknown>, value: unknown) {
  expect(result).toEqual({ ok: true, value });
}

export function expectParseError(
  result: EdgeParseResult<unknown>,
  code: EdgeParseErrorCode,
  path: string,
) {
  if (result.ok) throw new Error(`Expected ${code} at ${path}`);
  expect(result.error).toBeInstanceOf(EdgeParseError);
  expect(result.error.code).toBe(code);
  expect(result.error.path).toBe(path);
}
