// Ships the playground to production, in the order that never leaves the
// public shell calling functions prod lacks: the Convex functions to the
// codecast-playground prod deployment first, then the shell, built against
// it (.env.production), to the clayground Worker (wrangler.jsonc).
//
//   bun run deploy   from packages/playground
import { join } from "node:path";
import { $ } from "bun";

// Bun loads .env.local (the dev deployment) into the environment, where it
// would outrank .env.production in vite build and the deploy target in convex.
// CONVEX_DEPLOY_KEY goes too: one left in the shell from a Swarm backend
// deploy would send these functions over that backend.
const { CONVEX_URL, CONVEX_DEPLOYMENT, CONVEX_DEPLOY_KEY, ...env } = process.env;
$.cwd(join(import.meta.dir, "..")).env(env);
await $`bash ../../scripts/lib/fork-guard.sh ${"The playground deploy targets Codecast's playground and is disabled in Swarm."}`;
await $`bun scripts/build-sdk.ts --check`;
await $`npx convex deploy -y`;
await $`npx vite build`;
await $`bunx wrangler@4.148.0 deploy`;
