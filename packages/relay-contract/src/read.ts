export const RELAY_MAX_FRAME_BYTES = 8192;
export const RELAY_MAX_TOKEN_BYTES = 6144;

export type RelayParseErrorCode =
  | "invalid_input"
  | "invalid_json"
  | "too_large"
  | "invalid_field"
  | "unknown_field"
  | "unknown_kind";

export class RelayParseError extends Error {
  constructor(
    readonly code: RelayParseErrorCode,
    readonly path: string,
  ) {
    super(code);
  }
}

export type RelayParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: RelayParseErrorCode; path: string } };

type Reader<T> = (value: unknown, path: string) => T;
type Shape = Record<string, Reader<unknown>>;
type Fields<S extends Shape> = { [K in keyof S]: ReturnType<S[K]> };

export function parser<T>(
  read: Reader<T>,
): (wire: unknown) => RelayParseResult<T> {
  return (wire) => {
    if (typeof wire !== "string") {
      return { ok: false, error: { code: "invalid_input", path: "$" } };
    }
    if (
      wire.length > RELAY_MAX_FRAME_BYTES ||
      utf8Bytes(wire) > RELAY_MAX_FRAME_BYTES
    ) {
      return { ok: false, error: { code: "too_large", path: "$" } };
    }
    let value: unknown;
    try {
      value = JSON.parse(wire);
    } catch {
      return { ok: false, error: { code: "invalid_json", path: "$" } };
    }
    try {
      return { ok: true, value: read(value, "$") };
    } catch (error) {
      if (!(error instanceof RelayParseError)) throw error;
      return { ok: false, error: { code: error.code, path: error.path } };
    }
  };
}

function utf8Bytes(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint < 0x80) bytes += 1;
    else if (codePoint < 0x800) bytes += 2;
    else if (codePoint < 0x10000) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RelayParseError("invalid_field", path);
  }
  return value as Record<string, unknown>;
}

const owns = (value: object, key: string) =>
  Object.prototype.hasOwnProperty.call(value, key);

export function object<S extends Shape>(
  shape: S,
  allowExtra = false,
): Reader<Fields<S>> {
  return (value, path) => {
    const fields = record(value, path);
    if (!allowExtra) {
      for (const key of Object.keys(fields)) {
        if (!owns(shape, key))
          throw new RelayParseError("unknown_field", `${path}.${key}`);
      }
    }
    const parsed: Record<string, unknown> = {};
    for (const [key, read] of Object.entries(shape)) {
      const fieldPath = `${path}.${key}`;
      if (!owns(fields, key))
        throw new RelayParseError("invalid_field", fieldPath);
      parsed[key] = read(fields[key], fieldPath);
    }
    return parsed as Fields<S>;
  };
}

export function responseObject<S extends Shape>(shape: S): Reader<Fields<S>> {
  return object(shape, true);
}

export function tagged<S extends Shape>(
  key: string,
  variants: S,
): Reader<ReturnType<S[keyof S]>> {
  return (value, path) => {
    const fields = record(value, path);
    const fieldPath = `${path}.${key}`;
    const kind = fields[key];
    if (!owns(fields, key) || typeof kind !== "string") {
      throw new RelayParseError("invalid_field", fieldPath);
    }
    if (!owns(variants, kind))
      throw new RelayParseError("unknown_kind", fieldPath);
    return variants[kind](fields, path) as ReturnType<S[keyof S]>;
  };
}

export function oneOf<const T extends readonly (string | number | boolean)[]>(
  ...values: T
): Reader<T[number]> {
  return (value, path) => {
    if (!values.some((choice) => choice === value)) {
      throw new RelayParseError("invalid_field", path);
    }
    return value as T[number];
  };
}

export function string(pattern: RegExp): Reader<string> {
  return (value, path) => {
    if (typeof value !== "string" || pattern.exec(value)?.[0] !== value) {
      throw new RelayParseError("invalid_field", path);
    }
    return value;
  };
}

export function integer(minimum: number): Reader<number> {
  return (value, path) => {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < minimum
    ) {
      throw new RelayParseError("invalid_field", path);
    }
    return value;
  };
}

export function array<T>(
  read: Reader<T>,
  minimum: number,
  maximum: number,
): Reader<T[]> {
  return (value, path) => {
    if (
      !Array.isArray(value) ||
      value.length < minimum ||
      value.length > maximum
    ) {
      throw new RelayParseError("invalid_field", path);
    }
    return value.map((item, index) => read(item, `${path}[${index}]`));
  };
}

export function nullable<T>(read: Reader<T>): Reader<T | null> {
  return (value, path) => (value === null ? null : read(value, path));
}

export const boolean: Reader<boolean> = (value, path) => {
  if (typeof value !== "boolean")
    throw new RelayParseError("invalid_field", path);
  return value;
};

export const token = string(
  new RegExp(`^[a-zA-Z0-9_.-]{1,${RELAY_MAX_TOKEN_BYTES}}$`),
);
export const id = string(/^[a-zA-Z0-9_:-]{1,128}$/);
export const fraction: Reader<number> = (value, path) => {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new RelayParseError("invalid_field", path);
  }
  return value;
};
export const count = integer(0);
export const positive = integer(1);
