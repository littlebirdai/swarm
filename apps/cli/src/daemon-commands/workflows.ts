import { snippetBySlug } from "@codecast/snippets/snippets";
import {
  isMachineSetting,
  MACHINE_SETTINGS,
} from "@codecast/agent-clients/harnessHooks";
import * as fs from "fs";
import { harnessCauseEnv } from "../harness.js";
import { deviceId } from "../remote/device.js";
import {
  parseAgentToolSetupArgs,
  runAgentToolSetup,
} from "../agentToolSetup.js";
import { type Config } from "../config/types.js";
import type { CommandOutcome, DaemonCommandDeps } from "./dependencies.js";

export async function handleWorkflowCommand(
  daemon: Pick<
    DaemonCommandDeps,
    | "CONFIG_DIR"
    | "launchWorkflowRun"
    | "log"
    | "patchConfig"
    | "runApprovedCast"
    | "runCastCommand"
    | "sendHeartbeat"
    | "syncServiceRef"
  >,
  commandOutcome: CommandOutcome,
  command: string,
  config: Config,
  commandArgs: string | undefined,
  siteUrl: string,
): Promise<void> {
  const {
    CONFIG_DIR,
    launchWorkflowRun,
    log,
    patchConfig,
    runApprovedCast,
    runCastCommand,
    sendHeartbeat,
  } = daemon;
  switch (command) {
    case "cap_publish": {
      const { runCapPublishCommand } =
        await import("../capabilities/kitPublish.js");
      const outcome = await runCapPublishCommand(commandArgs, {
        siteUrl,
        apiToken: config.auth_token!,
        userId: config.user_id,
        home: process.env.HOME || require("os").homedir(),
        deviceId: deviceId(),
      });
      if ("error" in outcome) commandOutcome.error = outcome.error;
      else commandOutcome.result = outcome.result;
      log(
        `[capabilities] cap_publish ${"error" in outcome ? `failed: ${outcome.error.slice(0, 160)}` : "published"}`,
      );
      break;
    }
    case "run_workflow": {
      const parsed = commandArgs ? JSON.parse(commandArgs) : {};
      const workflowRunId = parsed.workflow_run_id;
      if (!workflowRunId) {
        commandOutcome.error = "Missing workflow_run_id";
        break;
      }
      const started = await launchWorkflowRun(
        siteUrl,
        config.auth_token!,
        workflowRunId,
      );
      if ("error" in started) commandOutcome.error = started.error;
      else
        commandOutcome.result = JSON.stringify({
          tmux_session: started.tmux_session,
          workflow_run_id: workflowRunId,
        });
      break;
    }
    case "run_cast": {
      // A person pressed Run on a `cast decide --run` card (commandRun.ts).
      // The command runs as theirs: outside the asking session (its session
      // env stripped, so the CLI sends no from_session), in the session's
      // folder. In the background, so a long command never holds the queue;
      // the run reports itself (sessionDecisions.reportCommandRun).
      const parsed = commandArgs ? JSON.parse(commandArgs) : {};
      const decisionId: string | undefined =
        typeof parsed.decision_id === "string" ? parsed.decision_id : undefined;
      const argv: string[] | null =
        Array.isArray(parsed.argv) &&
        parsed.argv.every((a: unknown) => typeof a === "string")
          ? parsed.argv
          : null;
      if (!decisionId || !argv?.length || argv[0] === "decide") {
        commandOutcome.error = "run_cast: missing decision_id or argv";
        break;
      }
      const cwd =
        typeof parsed.cwd === "string" && fs.existsSync(parsed.cwd)
          ? parsed.cwd
          : undefined;
      void runApprovedCast(decisionId, argv, cwd);
      commandOutcome.result = JSON.stringify({ started: true });
      break;
    }
    case "merge_back": {
      // An isolated subagent finished done: bring its worktree's changes
      // into its parent's checkout, all or nothing (mergeBack.ts), and
      // report the outcome; the server tells the parent and paints the chip.
      const parsed = commandArgs ? JSON.parse(commandArgs) : {};
      const conversationId: string | undefined = parsed.conversation_id;
      if (!conversationId || !parsed.worktree_path || !parsed.target_path) {
        commandOutcome.error =
          "merge_back: missing conversation_id, worktree_path or target_path";
        break;
      }
      const { mergeBack } = await import("../mergeBack.js");
      const outcome = await mergeBack(
        parsed.worktree_path,
        parsed.target_path,
      ).catch((err: Error) => ({
        state: "failed" as const,
        files: [] as string[],
        reason: err.message.split("\n")[0],
      }));
      log(
        `[MERGE-BACK] ${conversationId.slice(0, 12)} ${outcome.state}${outcome.files.length ? ` (${outcome.files.length} files)` : ""}${"reason" in outcome && outcome.reason ? `: ${outcome.reason}` : ""}`,
      );
      await daemon.syncServiceRef?.reportMergeBack({
        conversation_id: conversationId,
        state: outcome.state,
        files: outcome.files,
        ...("reason" in outcome && outcome.reason
          ? { reason: outcome.reason }
          : {}),
      });
      commandOutcome.result = JSON.stringify({
        state: outcome.state,
        files: outcome.files.length,
      });
      break;
    }
    case "apply_snippet": {
      // Web "Agent Features" changed a setting for THIS device. Run the very CLI
      // command a human would, then heartbeat so the new state round-trips back
      // within seconds. Two shapes: a boolean snippet (`cast install <slug>` /
      // `--disable`) or the tri-state stable hook (`cast stable <mode>`).
      const parsed = commandArgs ? JSON.parse(commandArgs) : {};
      const snippet = parsed.snippet;
      // Match aliases too: the web sends pre-rename slugs (e.g. "scheduling"
      // for triggers) so its toggles also work on daemons that predate a rename.
      // Machine settings ride the same command (MACHINE_SETTINGS): "hooks"
      // (codecast's Claude Code hooks, harnessHooksInstall.ts) runs its
      // installer; the rest are config flags only.
      const known =
        snippet === "stable" ||
        isMachineSetting(snippet) ||
        !!snippetBySlug(snippet);
      if (typeof snippet !== "string" || !known) {
        commandOutcome.error = `apply_snippet: unknown snippet ${JSON.stringify(snippet)}`;
        break;
      }
      if (isMachineSetting(snippet) && snippet !== "hooks") {
        // A config flag only (`cast update --auto` would also run an update).
        patchConfig({ [MACHINE_SETTINGS[snippet]]: parsed.enabled === true });
        log(
          `[SETTING] ${MACHINE_SETTINGS[snippet]} ${parsed.enabled ? "on" : "off"} (web toggle)`,
        );
        commandOutcome.result = JSON.stringify({
          snippet,
          enabled: parsed.enabled === true,
        });
        await sendHeartbeat().catch(() => {});
        break;
      }

      let cliArgs: string[];
      let logVerb: string;
      if (snippet === "stable") {
        const mode =
          parsed.mode === "team" || parsed.mode === "off"
            ? parsed.mode
            : "solo";
        cliArgs = ["stable", mode, ...(parsed.global ? ["-g"] : [])];
        logVerb = `stable=${mode}${parsed.global ? " (all projects)" : ""}`;
      } else {
        cliArgs = parsed.enabled
          ? ["install", snippet]
          : ["install", snippet, "--disable"];
        logVerb = `${parsed.enabled ? "installing" : "disabling"} ${snippet}`;
      }

      log(`[SNIPPET] ${logVerb} (web toggle)`);
      const res = await runCastCommand(cliArgs, {
        timeoutMs: 60 * 1000,
        env: harnessCauseEnv({
          why: `${snippet} turned ${parsed.enabled === false || parsed.mode === "off" ? "off" : "on"} in codecast settings`,
          automatic: false,
        }),
      });
      if (res.code === 0) {
        commandOutcome.result = JSON.stringify({
          snippet,
          ...(snippet === "stable"
            ? { mode: parsed.mode }
            : { enabled: parsed.enabled }),
        });
        // Push the freshly-written config state up now, don't wait for the
        // next ~30s beat — keeps the Settings control feeling instant.
        await sendHeartbeat().catch(() => {});
      } else {
        commandOutcome.error = `cast ${cliArgs[0]} failed (exit ${res.code}): ${(res.stderr || res.stdout || "").trim().slice(-300)}`;
      }
      break;
    }
    case "org_template_bind": {
      // The web's host step for a role hired from a template (org-hire.md
      // H3): run `cast org template bind` here, the machine with the checkout.
      // Secrets arrive sealed to this device's key and become 0600 files the
      // CLI binds by path (orgTemplateBindCommand.ts); no value is logged.
      const { runOrgTemplateBind } =
        await import("../orgTemplateBindCommand.js");
      const bound = await runOrgTemplateBind(
        CONFIG_DIR,
        commandArgs,
        (cliArgs) =>
          runCastCommand(cliArgs, {
            timeoutMs: 10 * 60 * 1000,
            env: harnessCauseEnv({
              why: "the host step of a template hire, pressed on the role page",
              automatic: false,
            }),
          }),
      );
      log(
        `[TEMPLATE] bound ${bound.instance}: ${bound.phase}${bound.bound.length ? ` (${bound.bound.length} secret${bound.bound.length === 1 ? "" : "s"})` : ""}`,
      );
      commandOutcome.result = JSON.stringify(bound);
      break;
    }
    case "agent_tool_setup": {
      // The setup card under a `cast browser`/`cast computer` command that
      // needed the Chrome extension or the macOS grants: check reads where
      // they stand here, start opens the next step on this screen.
      const setupArgs = parseAgentToolSetupArgs(commandArgs);
      if (!setupArgs) {
        commandOutcome.error =
          "agent_tool_setup needs a tool browser|computer and an op check|start";
        break;
      }
      commandOutcome.result = JSON.stringify(
        await runAgentToolSetup(setupArgs, {
          runCast: (a) => runCastCommand(a, { timeoutMs: 90 * 1000 }),
        }),
      );
      break;
    }
  }
}
