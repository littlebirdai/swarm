import { v } from "convex/values";

/** A tool call in codecast's rule terms (@codecast/policy/permissionRules PermissionRuleRequest). */
export const ruleRequestValidator = v.object({
  permission: v.string(),
  patterns: v.array(v.string()),
  always: v.array(v.string()),
  opaque: v.optional(v.boolean()),
});
