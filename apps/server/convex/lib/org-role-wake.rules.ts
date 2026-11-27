import { v, type Infer } from "convex/values";

const wakeRoleInput = {
  role_id: v.string(),
  message: v.string(),
  from_session: v.optional(v.string()),
  client_id: v.optional(v.string()),
};
const wakeRoleValidator = v.object(wakeRoleInput);
export type WakeRoleArgs = Infer<typeof wakeRoleValidator>;

export const wakeRoleArgs = {
  ...wakeRoleInput,
  api_token: v.optional(v.string()),
};
