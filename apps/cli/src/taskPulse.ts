// The task pulse: the file `cast task start` writes so a session knows which
// task and plan it is bound to (~/.codecast/task-pulse/<session>.json). Read
// by the pulse hook, the SessionStart task-context hook after a compaction
// (docs/architecture/task-graph.md TG10), `cast task context --current`, and
// `cast decide --task`'s default (docs/architecture/decisions-as-documents.md D3).
import * as fs from "fs";
import * as path from "path";
import { defaultConfigDir } from "./config/configDir.js";

export interface TaskPulse {
  task?: string;
  plan?: string;
  /** The session started the task (`recordTaskStart`), rather than filed it:
   *  only then can the compaction block say it held the task and lost it. */
  started?: boolean;
  claim_token?: number;
  lease_until?: number;
}

export interface TaskClaimState {
  short_id: string;
  claim_token: number;
  lease_until?: number;
}

function claimFile(shortId: string): string {
  const safe = shortId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(defaultConfigDir(), "task-claims", `${safe}.json`);
}

function readStandaloneClaim(shortId: string): TaskClaimState | null {
  try {
    const file = claimFile(shortId);
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (
      parsed &&
      parsed.short_id === shortId &&
      typeof parsed.claim_token === "number"
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function writeStandaloneClaim(
  shortId: string,
  claimToken: number,
  leaseUntil?: number,
): void {
  try {
    const file = claimFile(shortId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const data: TaskClaimState = {
      short_id: shortId,
      claim_token: claimToken,
      ...(typeof leaseUntil === "number" ? { lease_until: leaseUntil } : {}),
    };
    fs.writeFileSync(file, JSON.stringify(data));
  } catch {}
}

function clearStandaloneClaim(shortId: string): void {
  try {
    const file = claimFile(shortId);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {}
}

function pulseFile(sessionId: string): string {
  return path.join(defaultConfigDir(), "task-pulse", `${sessionId}.json`);
}

export function readTaskPulseFor(
  sessionId: string | null | undefined,
): TaskPulse | null {
  if (!sessionId) return null;
  try {
    const file = pulseFile(sessionId);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

export function writeTaskPulse(
  sessionId: string,
  taskId: string,
  planId?: string,
  opts: { started?: boolean; claim_token?: number; lease_until?: number } = {},
): void {
  try {
    const file = pulseFile(sessionId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const prev = readTaskPulseFor(sessionId);
    const data: TaskPulse = { task: taskId };
    if (planId) data.plan = planId;
    if (opts.started) data.started = true;
    const sameTask = prev?.task === taskId && taskId !== "";
    const token =
      opts.claim_token ?? (sameTask ? prev?.claim_token : undefined);
    const leaseUntil =
      opts.lease_until ??
      (opts.claim_token === undefined && sameTask
        ? prev?.lease_until
        : undefined);
    if (typeof token === "number") data.claim_token = token;
    if (typeof leaseUntil === "number") data.lease_until = leaseUntil;
    fs.writeFileSync(file, JSON.stringify(data));
  } catch {}
}

export function readTaskClaimToken(
  sessionId: string | null | undefined,
  shortId: string,
): number | undefined {
  if (sessionId) {
    const pulse = readTaskPulseFor(sessionId);
    if (pulse?.task === shortId && typeof pulse.claim_token === "number") {
      return pulse.claim_token;
    }
    return undefined;
  }
  return readStandaloneClaim(shortId)?.claim_token;
}

export function storeTaskClaim(
  sessionId: string | null | undefined,
  shortId: string,
  claimToken: number,
  leaseUntil?: number,
): void {
  if (sessionId) {
    const prev = readTaskPulseFor(sessionId);
    writeTaskPulse(
      sessionId,
      shortId,
      prev?.task === shortId ? prev.plan : undefined,
      {
        started: prev?.task === shortId ? prev.started : true,
        claim_token: claimToken,
        lease_until: leaseUntil,
      },
    );
    return;
  }
  writeStandaloneClaim(shortId, claimToken, leaseUntil);
}

export function updateTaskPulseLease(
  sessionId: string | null | undefined,
  shortId: string,
  claimToken: number,
  leaseUntil?: number,
): void {
  if (sessionId) {
    const prev = readTaskPulseFor(sessionId);
    if (prev && prev.task && prev.task !== shortId) return;
    writeTaskPulse(sessionId, shortId, prev?.plan, {
      started: prev?.started ?? true,
      claim_token: claimToken,
      lease_until: leaseUntil,
    });
    return;
  }
  writeStandaloneClaim(shortId, claimToken, leaseUntil);
}

export async function callWorkflowCliRoute(
  options: {
    convexSiteUrl?: string;
    apiToken?: string;
    runSession?: string;
    spawnerSession?: string;
    claimToken?: number;
  },
  route: string,
  body: Record<string, any>,
  fetchJson: (
    url: string,
    payload: Record<string, any>,
  ) => Promise<{ status: number; ok: boolean; data: any }>,
  onConflict: (reason: string, detail: string) => void,
): Promise<any | null> {
  if (!options.convexSiteUrl || !options.apiToken) return null;
  const fallbackSession = options.runSession ?? options.spawnerSession;
  const enriched =
    options.claimToken !== undefined && body.claim_token === undefined
      ? { ...body, claim_token: options.claimToken }
      : body;
  const { payload, sessionId } = prepareTaskClaimBody(
    route,
    enriched,
    fallbackSession,
  );
  try {
    const { status, ok, data } = await fetchJson(
      `${options.convexSiteUrl}${route}`,
      { api_token: options.apiToken, ...payload },
    );
    if (status === 409 || data?.code === "CONFLICT") {
      const reason = typeof data?.reason === "string" ? data.reason : "";
      const detail =
        typeof data?.error === "string"
          ? data.error
          : typeof data?.message === "string"
            ? data.message
            : "Task claim conflict";
      onConflict(reason, detail);
      if (
        clearStaleClaimOnConflict(data?.reason, sessionId, payload.short_id)
      ) {
        options.claimToken = undefined;
      }
      return null;
    }
    if (!ok || data?.error) return null;
    settleTaskClaimResult(route, payload, sessionId, data);
    if (typeof data?.claim_token === "number") {
      options.claimToken = data.claim_token;
    } else if (
      route === "/cli/work/release" ||
      (route === "/cli/work/update" &&
        TASK_CLAIM_RELEASE_STATUSES.has(String(payload.status ?? "")))
    ) {
      options.claimToken = undefined;
    }
    return data;
  } catch {
    return null;
  }
}

export function clearTaskClaimFor(
  sessionId: string | null | undefined,
  shortId: string,
): void {
  if (sessionId) {
    const prev = readTaskPulseFor(sessionId);
    if (prev?.task === shortId && prev.claim_token !== undefined) {
      const next: TaskPulse = { task: prev.task };
      if (prev.plan) next.plan = prev.plan;
      if (prev.started) next.started = prev.started;
      try {
        fs.writeFileSync(pulseFile(sessionId), JSON.stringify(next));
      } catch {}
    }
    return;
  }
  clearStandaloneClaim(shortId);
}

const TASK_CLAIM_WRITE_ROUTES = new Set([
  "/cli/work/update",
  "/cli/work/heartbeat",
  "/cli/work/renew",
  "/cli/work/release",
]);

const TASK_CLAIM_CONFLICT_ROUTES = new Set([
  ...TASK_CLAIM_WRITE_ROUTES,
  "/cli/work/claim",
  "/cli/work/spawn",
]);

export function isTaskClaimWriteRoute(route: string): boolean {
  return TASK_CLAIM_WRITE_ROUTES.has(route);
}

export function isTaskClaimConflictRoute(route: string): boolean {
  return TASK_CLAIM_CONFLICT_ROUTES.has(route);
}

const TASK_CLAIM_RELEASE_STATUSES = new Set([
  "done",
  "dropped",
  "open",
  "backlog",
  "in_review",
]);

const TASK_CLAIM_RELEASE_VERDICTS = new Set(["approve", "changes", "reject"]);

const TASK_CLAIM_INVALID_REASONS = new Set([
  "stale_token",
  "wrong_holder",
  "expired",
  "free",
]);

export function prepareTaskClaimBody(
  route: string,
  body: Record<string, any>,
  fallbackSessionId: string | null | undefined,
): {
  isTaskWrite: boolean;
  sessionId: string | null | undefined;
  payload: Record<string, any>;
} {
  const isTaskWrite = TASK_CLAIM_WRITE_ROUTES.has(route);
  if (!isTaskWrite) {
    return { isTaskWrite: false, sessionId: undefined, payload: body };
  }
  const explicitConv =
    typeof body.conversation_id === "string" ? body.conversation_id : undefined;
  const lookupSession = explicitConv ?? fallbackSessionId ?? null;
  if (
    typeof body.short_id !== "string" ||
    body.claim_token !== undefined ||
    (route === "/cli/work/update" &&
      body.status === "in_progress" &&
      !body.review_verdict)
  ) {
    return {
      isTaskWrite: true,
      sessionId: explicitConv ?? null,
      payload: body,
    };
  }
  const storedToken = readTaskClaimToken(lookupSession, body.short_id);
  if (storedToken === undefined) {
    return {
      isTaskWrite: true,
      sessionId: explicitConv ?? null,
      payload: body,
    };
  }
  const payload = {
    ...body,
    claim_token: storedToken,
    ...(lookupSession && explicitConv === undefined
      ? { conversation_id: lookupSession }
      : {}),
  };
  return {
    isTaskWrite: true,
    sessionId:
      typeof payload.conversation_id === "string"
        ? payload.conversation_id
        : null,
    payload,
  };
}

export function clearStaleClaimOnConflict(
  reason: unknown,
  sessionId: string | null | undefined,
  shortId: unknown,
): boolean {
  if (
    typeof shortId !== "string" ||
    !TASK_CLAIM_INVALID_REASONS.has(String(reason ?? ""))
  ) {
    return false;
  }
  clearTaskClaimFor(sessionId, shortId);
  return true;
}

export function settleTaskClaimResult(
  route: string,
  payload: Record<string, any>,
  _sessionId: string | null | undefined,
  result: any,
): void {
  if (
    !TASK_CLAIM_WRITE_ROUTES.has(route) ||
    typeof payload.short_id !== "string"
  )
    return;
  const requestSessionId =
    typeof payload.conversation_id === "string"
      ? payload.conversation_id
      : null;
  if (typeof result?.claim_token === "number") {
    storeTaskClaim(
      requestSessionId,
      payload.short_id,
      result.claim_token,
      typeof result.lease_until === "number" ? result.lease_until : undefined,
    );
    return;
  }
  if (
    route === "/cli/work/release" ||
    (route === "/cli/work/update" &&
      (TASK_CLAIM_RELEASE_STATUSES.has(String(payload.status ?? "")) ||
        TASK_CLAIM_RELEASE_VERDICTS.has(String(payload.review_verdict ?? ""))))
  ) {
    clearTaskClaimFor(requestSessionId, payload.short_id);
  }
}

export function clearTaskPulse(sessionId: string): void {
  try {
    const file = pulseFile(sessionId);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {}
}

// Clear the pulse ONLY when the closed task is the one the session is bound to.
// Closing a subtask under a still-claimed parent must not unbind the session:
// that would silence the reminder and break `cast task context --current`.
export function clearTaskPulseIfBound(
  sessionId: string | null | undefined,
  closedShortId: string,
): void {
  if (!sessionId) {
    clearStandaloneClaim(closedShortId);
    return;
  }
  if (readTaskPulseFor(sessionId)?.task === closedShortId)
    clearTaskPulse(sessionId);
}

/**
 * What filing a task leaves in the pulse. A session holding a task, one it
 * started here or one it is bound to on the server (the create's
 * `session_bound`), keeps that binding: a bug filed along the way is not the
 * work the reminder and the compaction block should name (TG5, TG10).
 * Otherwise the newest filed task takes the pulse, keeping its plan.
 */
export function recordTaskFiled(
  sessionId: string | null,
  shortId: string,
  planId: string | undefined,
  sessionBound?: boolean,
): void {
  if (!sessionId || sessionBound) return;
  const pulse = readTaskPulseFor(sessionId);
  if (pulse?.task && pulse.started) return;
  writeTaskPulse(sessionId, shortId, planId ?? pulse?.plan);
}

/**
 * What a start leaves behind in this shell, whatever the output mode (`cast
 * task start`, `cast task ready --claim`, with or without --json): the task
 * pulse, which the prompt reminder and the compaction block read
 * (task-graph.md TG10), and the plan binding. Resolves to the plan it bound.
 */
export async function recordTaskStart(
  sessionId: string | null,
  shortId: string,
  planId: string | undefined,
  bindPlan: (planId: string, sessionId: string) => Promise<unknown>,
  claim?: { claim_token?: number; lease_until?: number },
): Promise<string | null> {
  const claimToken =
    typeof claim?.claim_token === "number" ? claim.claim_token : undefined;
  const leaseUntil =
    typeof claim?.lease_until === "number" ? claim.lease_until : undefined;
  if (!sessionId) {
    if (claimToken !== undefined) {
      writeStandaloneClaim(shortId, claimToken, leaseUntil);
    }
    return null;
  }
  writeTaskPulse(sessionId, shortId, planId, {
    started: true,
    ...(claimToken !== undefined
      ? { claim_token: claimToken, lease_until: leaseUntil }
      : {}),
  });
  if (!planId) return null;
  try {
    await bindPlan(planId, sessionId);
    return planId;
  } catch {
    return null;
  }
}
