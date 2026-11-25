export type EdgeParseErrorCode =
  | "missing_field"
  | "unknown_field"
  | "invalid_type"
  | "invalid_value";

export class EdgeParseError extends TypeError {
  constructor(
    readonly code: EdgeParseErrorCode,
    readonly path: string,
    expected: string,
  ) {
    super(`${path}: ${expected}`);
    this.name = "EdgeParseError";
  }
}

export type EdgeParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: EdgeParseError };

export type Reader<T> = (value: unknown, path: string) => T;
type Shape = Record<string, Reader<unknown> | { optional: Reader<unknown> }>;
type Fields<S extends Shape> = {
  [
    K in keyof S as S[K] extends Reader<unknown> ? K : never
  ]: S[K] extends Reader<infer T> ? T : never;
} & {
  [
    K in keyof S as S[K] extends { optional: Reader<unknown> } ? K : never
  ]?: S[K] extends { optional: Reader<infer T> } ? T : never;
};

export const owns = (value: object, key: string) =>
  Object.prototype.hasOwnProperty.call(value, key);

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EdgeParseError("invalid_type", path, "expected an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) {
    throw new EdgeParseError("invalid_type", path, "expected a plain object");
  }
  return value as Record<string, unknown>;
}

export function parser<T>(
  read: Reader<T>,
): (value: unknown) => EdgeParseResult<T> {
  return (value) => {
    try {
      return { ok: true, value: read(value, "$") };
    } catch (error) {
      if (error instanceof EdgeParseError) return { ok: false, error };
      throw error;
    }
  };
}

export function object<S extends Shape>(shape: S): Reader<Fields<S>> {
  return (value, path) => {
    const fields = record(value, path);
    for (const key of Object.keys(fields)) {
      if (!owns(shape, key)) {
        throw new EdgeParseError(
          "unknown_field",
          `${path}.${key}`,
          "unexpected field",
        );
      }
    }
    return readFields(shape, fields, path);
  };
}

export function responseObject<S extends Shape>(shape: S): Reader<Fields<S>> {
  return (value, path) => readFields(shape, record(value, path), path);
}

function readFields<S extends Shape>(
  shape: S,
  fields: Record<string, unknown>,
  path: string,
): Fields<S> {
  const parsed: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(shape)) {
    const fieldPath = `${path}.${key}`;
    if (owns(fields, key)) {
      const read = typeof field === "function" ? field : field.optional;
      parsed[key] = read(fields[key], fieldPath);
    } else if (typeof field === "function") {
      throw new EdgeParseError("missing_field", fieldPath, "required field");
    }
  }
  return parsed as Fields<S>;
}

export const nullable =
  <T>(read: Reader<T>): Reader<T | null> =>
  (value, path) =>
    value === null ? null : read(value, path);

export const optional = <T>(read: Reader<T>) => ({ optional: read });

export function tagged<
  K extends string,
  S extends Record<string, Reader<unknown>>,
>(key: K, variants: S): Reader<ReturnType<S[keyof S]>> {
  return (value, path) => {
    const fields = record(value, path);
    const tagPath = `${path}.${key}`;
    if (!owns(fields, key))
      throw new EdgeParseError("missing_field", tagPath, "required field");
    const tag = string(fields[key], tagPath);
    if (!owns(variants, tag))
      throw new EdgeParseError("invalid_value", tagPath, "unknown variant");
    return variants[tag](value, path) as ReturnType<S[keyof S]>;
  };
}

export function oneOf<const T extends readonly (string | number | null)[]>(
  ...choices: T
): Reader<T[number]> {
  return (value, path) => {
    if (!choices.some((choice) => choice === value)) {
      throw new EdgeParseError(
        "invalid_value",
        path,
        `expected ${choices.join(" | ")}`,
      );
    }
    return value as T[number];
  };
}

export function array<T>(read: Reader<T>): Reader<T[]> {
  return (value, path) => {
    if (!Array.isArray(value))
      throw new EdgeParseError("invalid_type", path, "expected an array");
    const parsed: T[] = [];
    for (let index = 0; index < value.length; index++) {
      parsed.push(read(value[index], `${path}[${index}]`));
    }
    return parsed;
  };
}

export const string: Reader<string> = (value, path) => {
  if (typeof value !== "string")
    throw new EdgeParseError("invalid_type", path, "expected a string");
  return value;
};

export const boolean: Reader<boolean> = (value, path) => {
  if (typeof value !== "boolean")
    throw new EdgeParseError("invalid_type", path, "expected a boolean");
  return value;
};

export const nonEmptyString: Reader<string> = (value, path) => {
  const text = string(value, path);
  if (text.length === 0)
    throw new EdgeParseError(
      "invalid_value",
      path,
      "expected a non-empty string",
    );
  return text;
};

export function boundedText(
  maxLength: number,
  allowBlank = false,
): Reader<string> {
  return (value, path) => {
    const text = string(value, path);
    if (text.length > maxLength || (!allowBlank && !text.trim())) {
      throw new EdgeParseError(
        "invalid_value",
        path,
        `expected ${allowBlank ? "text" : "non-blank text"} of at most ${maxLength} code units`,
      );
    }
    return text;
  };
}

export const count: Reader<number> = (value, path) => {
  if (typeof value !== "number")
    throw new EdgeParseError("invalid_type", path, "expected a number");
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new EdgeParseError(
      "invalid_value",
      path,
      "expected a non-negative safe integer",
    );
  }
  return value;
};

export const positiveInteger: Reader<number> = (value, path) => {
  const number = count(value, path);
  if (number === 0)
    throw new EdgeParseError(
      "invalid_value",
      path,
      "expected a positive safe integer",
    );
  return number;
};

export type EdgeJson =
  | null
  | boolean
  | number
  | string
  | EdgeJson[]
  | { [key: string]: EdgeJson };

export const json: Reader<EdgeJson> = (value, path) => {
  const ancestors = new Set<object>();
  const stack = [{ value, path, exit: false }];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const item = node.value;
    if (
      item === null ||
      typeof item === "boolean" ||
      typeof item === "string" ||
      (typeof item === "number" && Number.isFinite(item))
    )
      continue;
    if (typeof item !== "object") {
      throw new EdgeParseError(
        "invalid_type",
        node.path,
        "expected a JSON value",
      );
    }
    if (node.exit) {
      ancestors.delete(item);
      continue;
    }
    if (ancestors.has(item))
      throw new EdgeParseError("invalid_value", node.path, "cyclic JSON value");
    ancestors.add(item);
    stack.push({ ...node, exit: true });
    if (Array.isArray(item)) {
      for (let index = item.length - 1; index >= 0; index--) {
        stack.push({
          value: item[index],
          path: `${node.path}[${index}]`,
          exit: false,
        });
      }
    } else {
      for (const [key, child] of Object.entries(record(item, node.path))) {
        stack.push({ value: child, path: `${node.path}.${key}`, exit: false });
      }
    }
  }
  return value as EdgeJson;
};
