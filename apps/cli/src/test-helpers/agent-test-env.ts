import { personEnv } from "../sessionIdentity.js";

const env = personEnv();
for (const key of Object.keys(process.env))
  if (!Object.prototype.hasOwnProperty.call(env, key)) delete process.env[key];
