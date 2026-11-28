import { v, type Validator } from "convex/values";
import type { Id } from "../_generated/dataModel";
import {
  LINE_CATEGORIES,
  LINE_READINESS,
  LINE_RISKS,
} from "@codecast/goals/goalsBrief";
import { resolveCallRef } from "../transcripts";
import { notFound } from "./auth";

// "" clears a ground field; any other value is checked by the validator.
export const orClear = <T extends string>(values: readonly T[]) =>
  v.optional(
    v.union(
      v.literal(""),
      ...values.map((x) => v.literal(x)),
    ) as unknown as Validator<T | "">,
  );

export const groundArgs = {
  goal_ref: v.optional(v.string()),
  category: orClear(LINE_CATEGORIES),
  risk: orClear(LINE_RISKS),
  readiness: orClear(LINE_READINESS),
  readiness_note: v.optional(v.string()),
};

export const GROUND_FIELDS = [
  "goal_ref",
  "category",
  "risk",
  "readiness",
  "readiness_note",
] as const;

export function groundPatch(
  args: Partial<Record<(typeof GROUND_FIELDS)[number], string>>,
): Record<string, string | undefined> {
  const patch: Record<string, string | undefined> = {};
  for (const field of GROUND_FIELDS) {
    const value = args[field];
    if (value !== undefined) patch[field] = value.trim() || undefined;
  }
  return patch;
}

/** A `from_call` write: the call a task was pulled from, named as prose names
 *  it (`cl-42` or a full id) and readable by the writer. Undefined writes
 *  nothing; "" clears the link. */
export async function resolveFromCall(
  ctx: any,
  userId: Id<"users">,
  ref: string | undefined,
): Promise<Id<"transcripts"> | null | undefined> {
  if (ref === undefined) return undefined;
  if (!ref.trim()) return null;
  const call = await resolveCallRef(ctx, userId, ref);
  if (!call) notFound(`Call not found: ${ref}`);
  return call._id;
}
