import { describe, expect, spyOn, test } from "bun:test";
import {
  classifyClaudeResumeFatalReason,
  executeCommandBatch,
  setSyncServiceForTests,
  getInitialManagedSessionId,
  shouldMaterializeFreshClaudeSession,
  shouldStartBlankSessionAfterResumeFailure,
} from "./daemon.js";
import { CloudAgentSessions } from "./cloudAgents/sessions.js";
import { SyncService } from "./syncService.js";

describe("getInitialManagedSessionId", () => {
  test("uses the expected conversation session id for fresh Claude sessions", () => {
    expect(getInitialManagedSessionId("claude", "Va2f0tvqiG")).toBe(
      "Va2f0tvqiG",
    );
  });

  test("prefers the app-server thread id for Codex sessions", () => {
    expect(
      getInitialManagedSessionId("codex", "placeholder-session", "thread-123"),
    ).toBe("thread-123");
  });

  test("classifies stale Claude resume failures", () => {
    expect(
      classifyClaudeResumeFatalReason(
        "No conversation found with session ID: abc",
      ),
    ).toBe("missing_conversation");
    expect(classifyClaudeResumeFatalReason("Session not found")).toBe(
      "session_not_found",
    );
    expect(classifyClaudeResumeFatalReason("command not found")).toBeNull();
  });

  test("materializes a fresh Claude session instead of starting a blank fallback for stale ids", () => {
    expect(shouldMaterializeFreshClaudeSession("missing_conversation")).toBe(
      true,
    );
    expect(shouldMaterializeFreshClaudeSession("session_not_found")).toBe(true);
    expect(
      shouldStartBlankSessionAfterResumeFailure("missing_conversation"),
    ).toBe(false);
    expect(shouldStartBlankSessionAfterResumeFailure(null)).toBe(true);
  });
});

test("daemon cloud starts queue the prompt under the command's delivery ID", async () => {
  const service = new SyncService({ convexUrl: "https://test.convex.cloud" });
  const projectInfo = spyOn(service, "getProjectInfo").mockResolvedValue(null);
  const status = spyOn(service, "updateSessionAgentStatus").mockResolvedValue(
    true,
  );
  const enqueue = spyOn(service, "enqueueUserMessage").mockResolvedValue(
    "queued",
  );
  const start = spyOn(CloudAgentSessions.prototype, "start").mockResolvedValue(
    undefined,
  );
  const fetch = spyOn(globalThis, "fetch").mockImplementation((async (url) => {
    switch (new URL(String(url)).pathname) {
      case "/cli/command-claim":
        return Response.json({ claimed: true });
      case "/cli/command-result":
        return Response.json({ ok: true });
      default:
        throw new Error(`Unexpected request: ${url}`);
    }
  }) as typeof globalThis.fetch);
  setSyncServiceForTests(service);
  try {
    const args = JSON.stringify({
      conversation_id: "cloud-session",
      project_path: "/workspace",
      agent_type: "cursor",
      model: "cloud",
      prompt: "Review the changes",
    });
    const commands = ["cloud-start-1", "cloud-start-2"].map((id) => ({
      id,
      command: "start_session",
      args,
    }));
    const config = {
      convex_url: "https://test.convex.cloud",
      auth_token: "test",
    };
    await executeCommandBatch(commands, config, "TEST");
    await executeCommandBatch(commands, config, "TEST");
    expect(enqueue.mock.calls).toEqual([
      [
        "cloud-session",
        "Review the changes",
        "cloud-launch:cloud-start-1",
        { human: true },
      ],
      [
        "cloud-session",
        "Review the changes",
        "cloud-launch:cloud-start-2",
        { human: true },
      ],
    ]);
  } finally {
    setSyncServiceForTests(null);
    for (const spy of [projectInfo, status, enqueue, start, fetch])
      spy.mockRestore();
  }
});
