import { isCloudAgentActionName } from "@codecast/agent-clients/cloudAgents";
import { CLOUD_START_RUN_MS } from "@codecast/cloud-hosts/cloudPlacement";
import { childErrorDetail } from "../proc.js";
import { isRemoteDevice, deviceId } from "../remote/device.js";
import {
  hostForDevice,
  dialsWithoutWaking,
  dialRemoteHost,
  noteDialError,
} from "../browser/cloudHost.js";
import type { CommandOutcome, DaemonCommandDeps } from "./dependencies.js";

export async function handleCloudCommand(
  daemon: Pick<
    DaemonCommandDeps,
    | "clearConversationDeliveryAndResumeState"
    | "cloudAgents"
    | "cloudSpawnInFlight"
    | "computeLocalProjectRoots"
    | "hostReports"
    | "invalidateLocalProjectRoots"
    | "liveSyncJobs"
    | "log"
    | "refreshLocalProjectRoots"
    | "runCastCommand"
    | "startMigrateChild"
    | "startMigrationRunner"
    | "stopLocalSessionBackends"
    | "syncServiceRef"
  >,
  commandOutcome: CommandOutcome,
  command: string,
  commandArgs: string | undefined,
): Promise<void> {
  const {
    clearConversationDeliveryAndResumeState,
    cloudAgents,
    cloudSpawnInFlight,
    computeLocalProjectRoots,
    hostReports,
    invalidateLocalProjectRoots,
    liveSyncJobs,
    log,
    refreshLocalProjectRoots,
    runCastCommand,
    startMigrateChild,
    startMigrationRunner,
    stopLocalSessionBackends,
  } = daemon;
  switch (command) {
    case "move_to_device": {
      // Web-triggered move: THIS (source) daemon transfers the worktree to the
      // destination device, flips ownership, and resumes there. Only reaches us
      // because the command was target_device_id'd to us.
      //
      // The transfer (git push / scp of the worktree) can be multi-GB and take
      // minutes. Running it inline (synchronous execFileSync) froze the event
      // loop past the watchdog's 180s stale-heartbeat threshold, so the daemon
      // was force-restarted mid-move and the handoff silently never completed.
      // Delegate to `cast remote move` in a child process (which does transfer
      // + ownership flip + resume) and await it WITHOUT blocking the loop, so
      // heartbeats keep flowing and the watchdog leaves us alone.
      const parsed = commandArgs ? JSON.parse(commandArgs) : {};
      const sessionId: string | undefined = parsed.session_id;
      const conversationId: string | undefined = parsed.conversation_id;
      const toDeviceId: string | undefined = parsed.to_device_id;
      if (!sessionId || !conversationId || !toDeviceId) {
        commandOutcome.error =
          "move_to_device: missing session_id/conversation_id/to_device_id";
        break;
      }
      log(
        `[MOVE] moving ${sessionId.slice(0, 8)} -> device ${toDeviceId.slice(0, 8)} (async child)`,
      );
      const moveRes = await runCastCommand([
        "remote",
        "move",
        sessionId,
        "--to-device",
        toDeviceId,
      ]);
      if (moveRes.code === 0) {
        // Stop the local copy so ONLY the destination runs it. Ownership now
        // points at the remote, but a still-live local tmux/process (started OR
        // auto-resumed) would keep answering delivered messages in parallel
        // (split-brain) — reap every local backend, then clear the in-memory
        // delivery/resume bookkeeping.
        await stopLocalSessionBackends(conversationId, sessionId).catch(
          () => {},
        );
        await clearConversationDeliveryAndResumeState(
          conversationId,
          sessionId,
          "move_to_device",
        ).catch(() => {});
        commandOutcome.result = JSON.stringify({ moved: true, to: toDeviceId });
        log(
          `[MOVE] done — ${sessionId.slice(0, 8)} now owned by ${toDeviceId.slice(0, 8)}`,
        );
      } else {
        const detail = childErrorDetail(moveRes.stderr, moveRes.stdout);
        commandOutcome.error = `move failed (exit ${moveRes.code})${detail ? `: ${detail}` : ""}`;
        log(
          `[MOVE] FAILED ${sessionId.slice(0, 8)} -> ${toDeviceId.slice(0, 8)}: ${commandOutcome.error}`,
        );
      }
      break;
    }
    case "cloud_spawn": {
      // The web asked for a session on the cloud host and this (local) daemon
      // was picked to prepare it: wake the box, refresh its checkout, copy the
      // manifest's secret files, acquire the worktree there, place the row.
      // A multi-minute SSH job, so it runs as `cast cloud start` in a child
      // exactly like move_to_device runs `cast remote move`.
      const parsed = commandArgs ? JSON.parse(commandArgs) : {};
      const conversationId: string | undefined = parsed.conversation_id;
      const cloudDeviceId: string | undefined = parsed.cloud_device_id;
      if (!conversationId) {
        commandOutcome.error = "cloud_spawn: missing conversation_id";
        break;
      }
      const earlier = cloudSpawnInFlight.get(conversationId);
      if (earlier) {
        log(
          `[CLOUD] ${conversationId.slice(0, 12)} already being prepared — waiting for that child first`,
        );
        await earlier.catch(() => {});
      }
      const { cloudStartArgs } = await import("../cloud/cli.js");
      const workspace: string | undefined = parsed.workspace;
      const startFrom: string | undefined = parsed.start_from;
      log(
        `[CLOUD] placing ${conversationId.slice(0, 12)} on the cloud host (${workspace === "shared" ? "shared checkout" : `isolated worktree from ${startFrom === "origin_main" ? "origin/main" : "this checkout"}`}, async child)`,
      );
      const child = runCastCommand(
        cloudStartArgs({
          conversation_id: conversationId,
          cloud_device_id: cloudDeviceId,
          workspace,
          start_from: startFrom,
          leave_out: Array.isArray(parsed.leave_out)
            ? parsed.leave_out
            : undefined,
        }),
        { timeoutMs: CLOUD_START_RUN_MS },
      );
      cloudSpawnInFlight.set(conversationId, child);
      let res: Awaited<typeof child>;
      try {
        res = await child;
      } finally {
        if (cloudSpawnInFlight.get(conversationId) === child)
          cloudSpawnInFlight.delete(conversationId);
      }
      if (res.code === 0) {
        commandOutcome.result =
          res.stdout
            .trim()
            .split("\n")
            .reverse()
            .find((l) => l.startsWith("{")) ?? JSON.stringify({ placed: true });
        log(
          `[CLOUD] placed ${conversationId.slice(0, 12)}: ${commandOutcome.result}`,
        );
      } else {
        const detail = childErrorDetail(res.stderr, res.stdout);
        commandOutcome.error = `cloud host preparation failed (exit ${res.code})${detail ? `: ${detail}` : ""}`;
        log(
          `[CLOUD] FAILED ${conversationId.slice(0, 12)}: ${commandOutcome.error}`,
          "warn",
        );
        // Through the park's token: a child whose park was superseded (the
        // row re-parked, re-pointed, or placed by another laptop) must not
        // write its error onto the park that replaced it.
        // A context over the cap names what would have to stay behind; the
        // banner asks the human whether to leave it out.
        const tooLarge = res.stdout
          .split("\n")
          .map((l) => {
            try {
              return JSON.parse(l)?.context_too_large;
            } catch {
              return undefined;
            }
          })
          .find(Boolean);
        daemon.syncServiceRef
          ?.reportCloudPlacementFailure(
            conversationId,
            parsed.placement_token,
            commandOutcome.error,
            tooLarge,
          )
          .catch((err) =>
            log(
              `[CLOUD] ${conversationId.slice(0, 12)}: ${err instanceof Error ? err.message : String(err)}`,
              "warn",
            ),
          );
      }
      break;
    }
    case "cloud_live_sync": {
      // Mirror a cloud session's tree into a worktree here, live (the web's
      // "Mirror edits to this laptop"), or stop. The jobs run in-process,
      // poll the host only while the session works, and report to
      // conversations.local_mirror (cloud/liveSyncJobs.ts).
      if (isRemoteDevice()) {
        commandOutcome.error = "a cloud host does not mirror sessions";
        break;
      }
      let mirrorArgs: any = null;
      try {
        mirrorArgs =
          typeof commandArgs === "string"
            ? JSON.parse(commandArgs)
            : commandArgs;
        if (mirrorArgs?.op) {
          // An agent's or a person's `cast sync status|pull|push|diff` (cloud/syncRequests.ts).
          const [{ handleSyncRequest }, { readSyncScope }] = await Promise.all([
            import("../cloud/syncRequests.js"),
            import("../cloud/syncScope.js"),
          ]);
          const ask = async () =>
            handleSyncRequest(mirrorArgs, {
              jobs: await liveSyncJobs(),
              hostFor: (id) => {
                const h = hostForDevice(id);
                return h?.address && dialsWithoutWaking(h)
                  ? dialRemoteHost(h)
                  : null;
              },
              scopeFor: (root) => readSyncScope(root),
              isProjectRoot: async (root) => {
                if (computeLocalProjectRoots().includes(root)) return true;
                invalidateLocalProjectRoots();
                await refreshLocalProjectRoots();
                return computeLocalProjectRoots().includes(root);
              },
            });
          const answer = await ask().catch((err) => {
            if (noteDialError(hostForDevice(mirrorArgs.host_device_id), err))
              return ask();
            throw err;
          });
          commandOutcome.result = JSON.stringify(answer);
        } else {
          commandOutcome.result = await (
            await liveSyncJobs()
          ).handleCommand(mirrorArgs);
        }
      } catch (err) {
        commandOutcome.error = err instanceof Error ? err.message : String(err);
        if (mirrorArgs?.conversation_id && !mirrorArgs.op)
          await daemon.syncServiceRef?.reportLocalMirror(
            mirrorArgs.conversation_id,
            deviceId(),
            { status: "error", error: commandOutcome.error.slice(0, 300) },
          );
      }
      break;
    }
    case "cloud_host_action": {
      // Wake, sleep, apply setup, save or delete an image, from the app's
      // Machines page. Each runs as a child `cast hosts ...` (AWS calls
      // block) and its outcome rides the host's next report (cloud/hostReports.ts).
      if (isRemoteDevice()) {
        commandOutcome.error = "a cloud host does not manage hosts";
        break;
      }
      try {
        const a =
          typeof commandArgs === "string"
            ? JSON.parse(commandArgs)
            : commandArgs;
        commandOutcome.result = await (await hostReports()).act(a);
      } catch (err) {
        commandOutcome.error = err instanceof Error ? err.message : String(err);
      }
      break;
    }
    case "cloud_browser_sync": {
      // A cloud session asked for this laptop's browser login for one site.
      // Laptop only, command-driven (no timer, no retry), one tunnel per
      // host at a time; the handler and its in-flight map live in
      // cloud/browserSync.ts. The child's line holds counts, never a cookie.
      const { handleBrowserSyncCommand } =
        await import("../cloud/browserSync.js");
      const out = await handleBrowserSyncCommand(commandArgs, {
        isRemoteDevice,
        runCastCommand,
        log,
        childErrorDetail,
      });
      commandOutcome.result = out.result;
      commandOutcome.error = out.error;
      break;
    }
    case "vault_capture_signin":
    case "vault_check_signin": {
      // The web's Save sign-in from this laptop's Chrome. The child reads
      // the cookies and stores them in the Vault (or, for a check, only
      // counts them); its line holds counts and a name, never a cookie
      // (secrets/signinCommand.ts).
      const { handleCaptureSigninCommand } =
        await import("../secrets/signinCommand.js");
      const out = await handleCaptureSigninCommand(
        commandArgs,
        { isRemoteDevice, runCastCommand, log, childErrorDetail },
        command === "vault_check_signin",
      );
      commandOutcome.result = out.result;
      commandOutcome.error = out.error;
      break;
    }
    case "migrate_sessions": {
      // A bulk migration batch names THIS machine as an executor. The work
      // is a chain of SSH transfers that can run for an hour, so it lives in
      // a DETACHED `cast migrate run` child: the command answers at once and
      // the runner reports every row's progress to Convex itself. Detached
      // (and unref'd) so a daemon restart mid-batch does not kill it — the
      // fence on each row is cleared by the runner or, if the runner dies,
      // by the server's stale-migration reaper.
      const parsed = commandArgs ? JSON.parse(commandArgs) : {};
      const batchId: string | undefined =
        typeof parsed.batch_id === "string" ? parsed.batch_id : undefined;
      if (!batchId || !/^mg-[a-z0-9]{4,32}$/.test(batchId)) {
        commandOutcome.error = "migrate_sessions: missing or invalid batch_id";
        break;
      }
      const started = startMigrationRunner(batchId);
      commandOutcome.result = JSON.stringify(started);
      log(
        `[MIGRATE] ${started.started ? `started runner for ${batchId} (pid ${started.pid})` : `runner for ${batchId} not started: ${started.reason}`}`,
      );
      break;
    }
    case "team_host_member": {
      // This daemon is a team machine's admin (the box's sudoer): a member
      // joins or leaves. Installing a person's tools takes minutes, so the
      // work runs in a detached `cast hosts team apply` child that claims
      // the row and reports each step itself (hosts/team.ts).
      const parsed = commandArgs ? JSON.parse(commandArgs) : {};
      const memberId: string | undefined =
        typeof parsed.member_id === "string" &&
        /^[a-z0-9]{16,40}$/.test(parsed.member_id)
          ? parsed.member_id
          : undefined;
      if (!memberId) {
        commandOutcome.error = "team_host_member: missing or invalid member_id";
        break;
      }
      const started = startMigrateChild(`team-host-${memberId}`, [
        "hosts",
        "team",
        "apply",
        memberId,
      ]);
      commandOutcome.result = JSON.stringify(started);
      log(
        `[TEAM-HOST] ${parsed.action ?? "change"} ${memberId}: ${started.started ? `started (pid ${started.pid})` : started.reason}`,
      );
      break;
    }
    case "rehearse_moves": {
      // The offload review asked for dry runs of moving sessions whose files
      // are here. Each takes a snapshot and an ssh round trip, so they run in
      // a detached `cast migrate rehearse` child that reports every row itself.
      const parsed = commandArgs ? JSON.parse(commandArgs) : {};
      const requestId: string | undefined =
        typeof parsed.request_id === "string" ? parsed.request_id : undefined;
      if (!requestId || !/^rh_[a-z0-9]{8,32}$/.test(requestId)) {
        commandOutcome.error = "rehearse_moves: missing or invalid request_id";
        break;
      }
      const started = startMigrateChild(requestId, [
        "migrate",
        "rehearse",
        "--request",
        requestId,
      ]);
      commandOutcome.result = JSON.stringify(started);
      log(
        `[MIGRATE] ${started.started ? `rehearsing ${requestId} (pid ${started.pid})` : `rehearsal ${requestId} not started: ${started.reason}`}`,
      );
      break;
    }
    case "cloud_agent_login": {
      // The web's Connect dialog for a sign-in based cloud agent provider
      // (Codex Cloud): "check" reads this machine's login and asks the
      // provider whose it is; "start" runs the provider's own sign-in in a
      // utility pane (it opens the browser here) and returns at once, and
      // the dialog checks until it lands. No token leaves the machine.
      const { provider, op, device_code } = (
        commandArgs ? JSON.parse(commandArgs) : {}
      ) as { provider?: string; op?: string; device_code?: boolean };
      if (!provider || (op !== "check" && op !== "start")) {
        commandOutcome.error =
          "cloud_agent_login needs a provider and op check|start";
        break;
      }
      if (op === "start") {
        // A device-code start answers the page (url) and the code (detail) to finish it on any device.
        const prompt = await cloudAgents.startLogin(provider, {
          deviceCode: device_code === true,
        });
        commandOutcome.result = JSON.stringify({
          state: "started",
          ...(prompt ? { url: prompt.url, detail: prompt.code } : {}),
        });
      } else {
        commandOutcome.result = JSON.stringify(
          await cloudAgents.checkLogin(provider),
        );
      }
      break;
    }
    case "cloud_agent_action": {
      // A session header's action on its cloud agent (Create PR, Apply
      // locally, Archive, Unarchive), run by the daemon that hosts the
      // session. The result is said in the thread and answered as `detail`.
      const { conversation_id: actionConversation, action } = (
        commandArgs ? JSON.parse(commandArgs) : {}
      ) as { conversation_id?: string; action?: unknown };
      if (!actionConversation || !isCloudAgentActionName(action)) {
        commandOutcome.error =
          "cloud_agent_action needs a conversation_id and an action";
        break;
      }
      const acted = await cloudAgents.act(actionConversation, action);
      commandOutcome.result = JSON.stringify({
        detail: acted.message,
        ...(acted.url ? { url: acted.url } : {}),
      });
      break;
    }
  }
}
