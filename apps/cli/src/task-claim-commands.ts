import { execSync } from "./proc.js";
import { withTaskClaimToken } from "./taskClaim.js";
import {
  clearTaskPulseIfBound,
  readTaskClaimToken,
  storeTaskClaim,
  updateTaskPulseLease,
} from "./taskPulse.js";

const WORKFLOW_RUN_TRANSITION_STATUSES = new Set([
  "open",
  "in_progress",
  "in_review",
  "done",
  "dropped",
]);

export async function postWorkflowAwareTaskUpdate(
  cliPost: TaskClaimCliDeps["cliPost"],
  shortId: string,
  sessionId: string | null,
  body: Record<string, any>,
  opts?: { throwOnError?: boolean },
): Promise<any> {
  const workflowRunId = process.env.run_id?.trim();
  const canUseRunTransition =
    Boolean(workflowRunId) &&
    !body.subtask_resolution &&
    typeof body.status === "string" &&
    WORKFLOW_RUN_TRANSITION_STATUSES.has(body.status) &&
    Object.keys(body).every(
      (k) =>
        k === "short_id" ||
        k === "status" ||
        k === "conversation_id" ||
        k === "execution_status" ||
        k === "execution_concerns" ||
        k === "verification_evidence",
    );
  if (canUseRunTransition) {
    return await cliPost(
      "/cli/workflow-runs/task-transition",
      {
        run_id: workflowRunId,
        short_id: shortId,
        status: body.status,
        ...(body.execution_status !== undefined
          ? { execution_status: body.execution_status }
          : {}),
        ...(body.execution_concerns !== undefined
          ? { execution_concerns: body.execution_concerns }
          : {}),
        ...(body.verification_evidence !== undefined
          ? { verification_evidence: body.verification_evidence }
          : {}),
      },
      opts,
    );
  }
  return await cliPost(
    "/cli/work/update",
    withTaskClaimToken(body, readTaskClaimToken(sessionId, shortId)),
    opts,
  );
}

export interface TaskClaimCliDeps {
  cliPost: (
    urlPath: string,
    body: Record<string, any>,
    opts?: { timeoutMs?: number; throwOnError?: boolean },
  ) => Promise<any>;
  ownSessionId: (cwd: string) => string | null;
  getRealCwd: () => string;
  colors: {
    green: string;
    cyan: string;
    dim: string;
    yellow: string;
    reset: string;
  };
  readConfig: () => any;
  webUrl: string;
  isOlderBackendRefusal: (err: unknown, field: string) => boolean;
}

export async function runTaskSpawnForStart(
  deps: Pick<TaskClaimCliDeps, "cliPost" | "colors" | "readConfig" | "webUrl">,
  shortId: string,
  sessionId: string | null,
  options: any,
): Promise<void> {
  const spawnBody: Record<string, any> = { short_id: shortId };
  if (options.agent) spawnBody.agent_type = options.agent;
  if (options.message) spawnBody.initial_message = options.message;
  if (options.isolated || options.worktree) spawnBody.isolated = true;
  if (options.worktree) spawnBody.worktree_name = options.worktree;
  if (options.device) spawnBody.device = options.device;
  if (options.as) spawnBody.definition = options.as;
  const spawned = await deps.cliPost("/cli/work/spawn", spawnBody);
  if (spawned?.sessionId && typeof spawned?.claim_token === "number") {
    if (sessionId !== spawned.sessionId) {
      clearTaskPulseIfBound(sessionId, shortId);
    }
    storeTaskClaim(
      spawned.sessionId,
      shortId,
      spawned.claim_token,
      typeof spawned.lease_until === "number" ? spawned.lease_until : undefined,
    );
  }
  const link = `${deps.readConfig()?.web_url || deps.webUrl}/conversation/${spawned.conversationId}`;
  const { c } = { c: deps.colors };
  console.log(
    `${c.green}ok${c.reset} spawned ${c.cyan}${spawned.sessionId}${c.reset} for ${c.cyan}${shortId}${c.reset}`,
  );
  console.log(`  ${c.dim}${link}${c.reset}`);
}

export async function fileVerdictFindings(
  deps: Pick<
    TaskClaimCliDeps,
    "cliPost" | "getRealCwd" | "colors" | "isOlderBackendRefusal"
  >,
  shortId: string,
  conversationId: string | undefined,
  note: string | undefined,
): Promise<void> {
  const { parseFindings } = await import("./reviewFindings.js");
  const { findings } = parseFindings(note);
  if (findings.length === 0) return;
  const task = await deps
    .cliPost("/cli/work/get", { short_id: shortId })
    .catch(() => null);
  const taskId = task?.task?._id ?? task?._id ?? task?.id;
  const gitRoot = (() => {
    try {
      return execSync("git rev-parse --show-toplevel", {
        cwd: deps.getRealCwd(),
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
    } catch {
      return deps.getRealCwd();
    }
  })();
  const failed: string[] = [];
  for (const f of findings) {
    const add = (session: boolean) =>
      deps.cliPost(
        "/cli/review/add",
        {
          git_root: gitRoot,
          file_path: f.file_path,
          line_number: f.line_number,
          line_end: f.line_end,
          content: `[${f.severity}] ${f.content}`,
          severity: f.severity,
          task_id: taskId,
          ...(session ? { conversation_id: conversationId } : {}),
          author_kind: "agent",
          disposition: f.disposition,
          owner: f.owner,
          due_at: f.due_at,
        },
        { throwOnError: true },
      );
    try {
      await add(true).catch((err: Error) => {
        if (deps.isOlderBackendRefusal(err, "conversation_id"))
          return add(false);
        throw err;
      });
    } catch (err) {
      failed.push(
        `${f.file_path}${f.line_number ? `:${f.line_number}` : ""}: ${(err as Error).message}`,
      );
    }
  }
  const { c } = { c: deps.colors };
  const filed = findings.length - failed.length;
  console.log(
    `${c.dim}${filed}/${findings.length} findings recorded on ${shortId}${c.reset}`,
  );
  if (failed.length) {
    console.error(
      `${c.yellow}note${c.reset} verdict recorded; ${failed.length} finding${failed.length === 1 ? "" : "s"} not filed:`,
    );
    for (const line of failed) console.error(`  ${line}`);
  }
}

export async function runTaskHeartbeat(
  deps: Pick<
    TaskClaimCliDeps,
    "cliPost" | "ownSessionId" | "getRealCwd" | "colors"
  >,
  shortId: string,
  options: { progress?: string; token?: string },
): Promise<void> {
  const sessionId = deps.ownSessionId(deps.getRealCwd());
  const claimToken =
    options.token !== undefined
      ? Number(options.token)
      : readTaskClaimToken(sessionId, shortId);
  const body: Record<string, any> = { short_id: shortId };
  if (sessionId) body.conversation_id = sessionId;
  if (claimToken !== undefined && Number.isFinite(claimToken)) {
    body.claim_token = claimToken;
  }
  if (options.progress !== undefined) {
    const pct = Number(options.progress);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      console.error("--progress must be between 0 and 100");
      process.exit(1);
    }
    body.progress_pct = pct;
  }
  const res = await deps.cliPost("/cli/work/heartbeat", body);
  if (typeof res?.claim_token === "number") {
    updateTaskPulseLease(sessionId, shortId, res.claim_token, res.lease_until);
  }
  const { c } = { c: deps.colors };
  console.log(
    `${c.green}ok${c.reset} Heartbeat recorded for ${c.cyan}${shortId}${c.reset}`,
  );
}

export async function runTaskRenew(
  deps: Pick<
    TaskClaimCliDeps,
    "cliPost" | "ownSessionId" | "getRealCwd" | "colors"
  >,
  shortId: string,
  options: { progress?: string; token?: string },
): Promise<void> {
  const sessionId = deps.ownSessionId(deps.getRealCwd());
  const claimToken =
    options.token !== undefined
      ? Number(options.token)
      : readTaskClaimToken(sessionId, shortId);
  if (claimToken === undefined || !Number.isFinite(claimToken)) {
    console.error(
      `Error: no stored claim_token for ${shortId}; pass --token <n> or start it first`,
    );
    process.exit(1);
  }
  const body: Record<string, any> = {
    short_id: shortId,
    claim_token: claimToken,
  };
  if (sessionId) body.conversation_id = sessionId;
  if (options.progress !== undefined) {
    const pct = Number(options.progress);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      console.error("--progress must be between 0 and 100");
      process.exit(1);
    }
    body.progress_pct = pct;
  }
  const res = await deps.cliPost("/cli/work/renew", body);
  const { c } = { c: deps.colors };
  if (typeof res?.claim_token === "number") {
    updateTaskPulseLease(sessionId, shortId, res.claim_token, res.lease_until);
  }
  console.log(
    `${c.green}ok${c.reset} Renewed claim on ${c.cyan}${shortId}${c.reset}`,
  );
}

export async function runTaskRelease(
  deps: Pick<
    TaskClaimCliDeps,
    "cliPost" | "ownSessionId" | "getRealCwd" | "colors"
  >,
  shortId: string,
  options: { token?: string },
): Promise<void> {
  const sessionId = deps.ownSessionId(deps.getRealCwd());
  const claimToken =
    options.token !== undefined
      ? Number(options.token)
      : readTaskClaimToken(sessionId, shortId);
  if (claimToken === undefined || !Number.isFinite(claimToken)) {
    console.error(
      `Error: no stored claim_token for ${shortId}; pass --token <n> or start it first`,
    );
    process.exit(1);
  }
  const body: Record<string, any> = {
    short_id: shortId,
    claim_token: claimToken,
  };
  if (sessionId) body.conversation_id = sessionId;
  await deps.cliPost("/cli/work/release", body);
  clearTaskPulseIfBound(sessionId, shortId);
  const { c } = { c: deps.colors };
  console.log(`${c.green}ok${c.reset} Released ${c.cyan}${shortId}${c.reset}`);
}
