// THE GATED CONVEX PUSHER: what dev.sh runs instead of a raw `convex dev`.
//
// `convex dev` pushes the working tree on every save. Its typecheck
// does not make that safe: the CLI bundles the tree, THEN runs tsc against the
// disk, so two saves inside one push window can bundle a broken state and
// typecheck a fixed one. On 2026-09-21 that shipped a getTeamMembers with its
// `feedFilter` declaration removed and its use still present, and every open
// avatar bar latched "Failed to load" on the ReferenceError.
//
// This pusher makes a push a proof instead of a reflex:
//   1. wait until everything the backend bundles (the functions directory,
//      packages/shared and platform/packages) has been quiet for QUIET_MS;
//   2. refuse while the tree is behind origin/main (a snapshot push from a
//      stale tree deletes newer functions from prod, the 2026-07-15 outage);
//   3. take a signature of every file that ships;
//   4. run the whole-program typecheck (`cast check convex`; a plain tsc when
//      cast is not on PATH) and stop on any error;
//   5. push once (`convex dev --once --typecheck disable`);
//   6. take the signature again. If it moved, the push may have bundled a
//      mid-edit state, so it is dirty again and goes around once more.
// Function logs keep streaming in the same pane through `convex logs`.
//
// The state machine is `Gate`, with every side effect injected, so the test
// beside this file drives it with fakes; `main` below wires the real ones.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync, watch } from "node:fs";
import { join, relative, sep } from "node:path";

export const QUIET_MS = 3_000;
export const STALE_RETRY_MS = 60_000;
export const FAILED_PUSH_RETRY_MS = 60_000;

/** Files whose change is worth a push. Codegen output is written BY the push
 *  and must not retrigger it; tests and their fixtures (`*.testkit.ts`,
 *  `*.testing.ts`) never ship; editors leave dotfiles. `rel` is relative to
 *  the functions directory, or repo-relative for the other bundled sources. */
export function shipsToProd(rel: string): boolean {
  const parts = rel.split(/[\\/]/);
  if (
    parts.some(
      (p) => p.startsWith(".") || p === "_generated" || p === "node_modules",
    )
  )
    return false;
  const last = parts[parts.length - 1] ?? "";
  if (/\.(test|testkit|testing)\.[cm]?[jt]sx?$/.test(last)) return false;
  return /\.[cm]?[jt]sx?$|\.json$/.test(last);
}

/** One string that changes when any shipping file's bytes could have. */
export function signatureOf(
  entries: Iterable<{ rel: string; mtimeMs: number; size: number }>,
): string {
  return [...entries]
    .filter((e) => shipsToProd(e.rel))
    .map((e) => `${e.rel}\u0000${Math.round(e.mtimeMs)}\u0000${e.size}`)
    .sort()
    .join("\n");
}

/** Every directory the backend bundles, the same set deploy.sh reads: the
 *  functions, the shared package they import (`@codecast/shared`) and the
 *  vendored platform packages. `prefix` namespaces a file in the signature
 *  and the log; functions keep their bare path. */
export function bundledSources(
  root: string,
): { dir: string; prefix: string }[] {
  return [
    { dir: join(root, "apps", "server", "convex"), prefix: "" },
    { dir: join(root, "packages", "shared"), prefix: "packages/shared/" },
    { dir: join(root, "platform", "packages"), prefix: "platform/packages/" },
  ];
}

export type CheckResult = { errors: number; diagnostics: string };

export type GateIO = {
  now: () => number;
  /** Is HEAD a superset of `base`? */
  treeIsFresh: () => Promise<boolean>;
  /** The ref freshness is judged against, for the log. Defaults to origin/main. */
  base?: string;
  signature: () => Promise<string>;
  typecheck: () => Promise<CheckResult>;
  /** Exit code of the push. */
  push: () => Promise<number>;
  log: (line: string) => void;
};

export class Gate {
  private dirty = true; // a fresh pusher pushes once, the way `convex dev` did
  private lastChangeAt: number;
  private retryAt = 0;
  private busy = false;
  private wasStale = false;
  pushes = 0;

  constructor(private io: GateIO) {
    this.lastChangeAt = io.now() - QUIET_MS; // startup: no quiet wait
  }

  /** A shipping file changed on disk. */
  onChange(rel?: string): void {
    if (rel !== undefined && !shipsToProd(rel)) return;
    this.dirty = true;
    this.lastChangeAt = this.io.now();
    this.retryAt = 0;
  }

  /** One turn of the loop. Returns what it did, for the log and the tests. */
  async tick(): Promise<
    "idle" | "quiet" | "stale" | "errors" | "pushed" | "failed" | "moved"
  > {
    if (this.busy || !this.dirty) return "idle";
    const now = this.io.now();
    if (now - this.lastChangeAt < QUIET_MS || now < this.retryAt)
      return "quiet";
    this.busy = true;
    try {
      if (!(await this.io.treeIsFresh())) {
        if (!this.wasStale) {
          const base = this.io.base ?? "origin/main";
          this.io.log(
            `REFUSING to push: this tree is BEHIND ${base}. Run: git pull --rebase ${base.replace("/", " ")} — the push resumes on its own.`,
          );
        }
        this.wasStale = true;
        this.retryAt = this.io.now() + STALE_RETRY_MS;
        return "stale";
      }
      if (this.wasStale) this.io.log("Tree is fresh again.");
      this.wasStale = false;

      const before = await this.io.signature();
      const check = await this.io.typecheck();
      if (check.errors > 0) {
        this.io.log(
          `NOT pushing: ${check.errors} type error(s) in the convex program.`,
        );
        for (const line of check.diagnostics.split("\n"))
          if (line.trim()) this.io.log(`  ${line}`);
        // Wait for the next save; a red tree does not change by itself.
        this.dirty = false;
        return "errors";
      }

      this.dirty = false;
      this.io.log("Typecheck green.");
      this.io.log("Pushing to the dev deployment…");
      const code = await this.io.push();
      const after = await this.io.signature();
      if (after !== before) {
        this.io.log(
          "Files changed while the push ran; that push may hold a mid-edit state, pushing again after the tree settles.",
        );
        this.dirty = true;
        this.lastChangeAt = this.io.now();
        return "moved";
      }
      if (code !== 0) {
        this.io.log(
          `Push failed (exit ${code}). Retrying in ${FAILED_PUSH_RETRY_MS / 1000}s, or on the next save.`,
        );
        this.dirty = true;
        this.retryAt = this.io.now() + FAILED_PUSH_RETRY_MS;
        return "failed";
      }
      this.pushes += 1;
      this.io.log("Pushed.");
      return "pushed";
    } finally {
      this.busy = false;
    }
  }
}

// ---- the real IO -----------------------------------------------------------

const PKG = join(import.meta.dir, "..");
const ROOT = join(PKG, "..", "..");
const FUNCTIONS = join(PKG, "convex");
const SOURCES = bundledSources(ROOT);

function stamp(): string {
  return new Date().toTimeString().slice(0, 8);
}
function log(line: string): void {
  console.log(`\x1b[90m[${stamp()}]\x1b[0m \x1b[36mconvex-push\x1b[0m ${line}`);
}

function run(
  cmd: string[],
  opts: {
    cwd: string;
    timeoutMs?: number;
    inherit?: boolean;
    env?: NodeJS.ProcessEnv;
  },
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd[0]!, cmd.slice(1), {
      cwd: opts.cwd,
      stdio: opts.inherit ? "inherit" : ["ignore", "pipe", "inherit"],
      env: opts.env ?? process.env,
    });
    let stdout = "";
    child.stdout?.on("data", (d) => {
      stdout += d;
    });
    const timer = opts.timeoutMs
      ? setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs)
      : null;
    child.on("error", () => {
      if (timer) clearTimeout(timer);
      resolve({ code: 127, stdout });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout });
    });
  });
}

async function baseRemote(): Promise<string> {
  const r = await run(
    ["bash", join(ROOT, "scripts", "convex-base-remote.sh")],
    { cwd: ROOT, timeoutMs: 10_000 },
  );
  return (r.code === 0 && r.stdout.trim()) || "origin";
}

function treeIsFreshAgainst(remote: string): () => Promise<boolean> {
  return async () => {
    // Offline (fetch fails or hangs under load), judge by the last-known
    // <remote>/main rather than blocking local dev — the same rule dev.sh applies.
    await run(["git", "fetch", remote, "--quiet"], {
      cwd: ROOT,
      timeoutMs: 20_000,
    });
    const r = await run(
      ["git", "merge-base", "--is-ancestor", `${remote}/main`, "HEAD"],
      { cwd: ROOT, timeoutMs: 30_000 },
    );
    return r.code === 0;
  };
}

async function signature(): Promise<string> {
  const entries: { rel: string; mtimeMs: number; size: number }[] = [];
  // Walk by hand so dependency and dot directories are never descended into.
  const walk = (dir: string, prefix: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (
        name.startsWith(".") ||
        name === "node_modules" ||
        name === "_generated"
      )
        continue;
      const abs = join(dir, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(abs, `${prefix}${name}/`);
      else if (st.isFile())
        entries.push({
          rel: `${prefix}${name}`,
          mtimeMs: st.mtimeMs,
          size: st.size,
        });
    }
  };
  for (const source of SOURCES) walk(source.dir, source.prefix);
  // The package manifest ships too (a dependency change re-bundles).
  const pkg = statSync(join(PKG, "package.json"));
  entries.push({ rel: "package.json", mtimeMs: pkg.mtimeMs, size: pkg.size });
  return signatureOf(entries);
}

async function typecheck(): Promise<CheckResult> {
  const viaCast = await run(["cast", "check", "convex", "--json"], {
    cwd: ROOT,
    timeoutMs: 10 * 60_000,
  });
  if (viaCast.code !== 127) {
    try {
      const rows = JSON.parse(viaCast.stdout) as CheckResult[];
      const row = rows.find((r: any) => r.project === "convex") ?? rows[0];
      if (row && typeof row.errors === "number")
        return { errors: row.errors, diagnostics: row.diagnostics ?? "" };
    } catch {
      /* fall through to a plain tsc */
    }
  }
  const tsc = await run(
    [
      join(PKG, "node_modules", ".bin", "tsc"),
      "--noEmit",
      "-p",
      join(FUNCTIONS, "tsconfig.json"),
    ],
    { cwd: PKG, timeoutMs: 10 * 60_000 },
  );
  return { errors: tsc.code === 0 ? 0 : 1, diagnostics: tsc.stdout };
}

export function devEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (
    env.CONVEX_DEPLOY_KEY ||
    env.CONVEX_SELF_HOSTED_URL ||
    env.CONVEX_SELF_HOSTED_ADMIN_KEY ||
    env.CONVEX_PROVISION_HOST
  ) {
    throw new Error(
      "The Swarm watcher accepts only Convex dev deployments. Remove deploy keys and server overrides from the dev environment.",
    );
  }
  // Older local setups use "anonymous" without a deployment name.
  const deployment =
    env.CONVEX_DEPLOYMENT === "anonymous" ? "" : (env.CONVEX_DEPLOYMENT ?? "");
  if (
    deployment &&
    !/^(?:(?:dev|local):[\w-]+|anonymous-[\w-]+)$/.test(deployment)
  ) {
    throw new Error(
      "Set CONVEX_DEPLOYMENT to a Convex dev or local deployment.",
    );
  }
  // Empty values also prevent the CLI's dotenv loader from filling these keys
  // from files after this check. Pin the checked deployment for logs and pushes.
  return {
    ...env,
    CONVEX_DEPLOYMENT: deployment,
    CONVEX_DEPLOY_KEY: "",
    CONVEX_SELF_HOSTED_URL: "",
    CONVEX_SELF_HOSTED_ADMIN_KEY: "",
    CONVEX_PROVISION_HOST: "",
  };
}

async function push(env: NodeJS.ProcessEnv): Promise<number> {
  // Step 4 already proved the tree green; the CLI's own pass would be a second fresh whole-program tsc per push.
  const r = await run(
    [
      join(PKG, "node_modules", ".bin", "convex"),
      "dev",
      "--once",
      "--typecheck",
      "disable",
    ],
    { cwd: PKG, inherit: true, timeoutMs: 15 * 60_000, env },
  );
  return r.code;
}

function tailLogs(env: NodeJS.ProcessEnv): void {
  const child = spawn(join(PKG, "node_modules", ".bin", "convex"), ["logs"], {
    cwd: PKG,
    stdio: "inherit",
    env,
  });
  child.on("close", () => setTimeout(() => tailLogs(env), 5_000));
}

async function main(): Promise<void> {
  if (!existsSync(FUNCTIONS))
    throw new Error(`no functions directory at ${FUNCTIONS}`);
  const env = devEnv(process.env);
  const remote = await baseRemote();
  const gate = new Gate({
    now: Date.now,
    treeIsFresh: treeIsFreshAgainst(remote),
    base: `${remote}/main`,
    signature,
    typecheck,
    push: () => push(env),
    log,
  });
  for (const source of SOURCES) {
    if (!existsSync(source.dir)) continue;
    watch(source.dir, { recursive: true }, (_event, filename) => {
      const rel =
        filename == null
          ? undefined
          : source.prefix + String(filename).split(sep).join("/");
      if (rel === undefined || shipsToProd(rel)) gate.onChange(rel);
    });
  }
  log(
    `Watching ${SOURCES.map((s) => relative(ROOT, s.dir)).join(", ")}: a push waits ${QUIET_MS / 1000}s of quiet, a tree not behind ${remote}/main and a green typecheck.`,
  );
  log("Production diff and push recording are disabled in Swarm.");
  tailLogs(env);
  for (;;) {
    await gate.tick();
    await new Promise((r) => setTimeout(r, 500));
  }
}

if (import.meta.main)
  main().catch((error) => {
    log(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
