import { v } from "convex/values";
import { TASK_STATUS_CATEGORIES } from "@codecast/tasks/statuses";

export const taskStatusCategoryValidator = v.union(
  ...TASK_STATUS_CATEGORIES.map((s) => v.literal(s)),
);
