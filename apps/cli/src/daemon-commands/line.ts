import * as fs from "fs";
import * as path from "path";
import { agentSpawnPath } from "../agentSpawnPath.js";
import { atomicWriteFile } from "../atomicWrite.js";
import { type Config } from "../config/types.js";
import type { CommandOutcome, DaemonCommandDeps } from "./dependencies.js";
import { postCommandResult } from "./post-command-result.js";

export async function handleLineCommand(
  daemon: Pick<
    DaemonCommandDeps,
    "fencedTarget" | "log" | "republishLineProfileSoon" | "runCastCommand"
  >,
  commandOutcome: CommandOutcome,
  commandId: string,
  command: string,
  config: Config,
  commandArgs: string | undefined,
  siteUrl: string,
): Promise<void> {
  const { fencedTarget, log, republishLineProfileSoon, runCastCommand } =
    daemon;
  switch (command) {
    case "line_profile_edit": {
      // The app's edit of a project's .codecast/line.toml: key-level edits
      // applied in place (comments survive), validated by the profile
      // loader before anything is written, then republished so the app's
      // copy follows. The read, edit and write stay inline so edits land in
      // order; the republish (a cast cold start) runs off the command queue
      // and the reply says it is pending. args: LineProfileEditArgs.
      // Result: LineProfileEditReply.
      const { runLineProfileEdit, removeLineFile } =
        await import("../lineProfileEdit.js");
      try {
        let answered: string | undefined;
        const reply = await runLineProfileEdit(
          commandArgs ? JSON.parse(commandArgs) : {},
          {
            admit: (file) => fencedTarget(file, "line_profile"),
            // A station edit may write `.codecast/line/` for the first time (LX5).
            write: (file, content) => {
              fs.mkdirSync(path.dirname(file), { recursive: true });
              atomicWriteFile(
                file,
                content,
                fs.existsSync(file) ? {} : { mode: 0o644 },
              );
            },
            remove: removeLineFile,
            // After the reply is reported, the republish runs and reports again
            // on this command with how it went.
            publish: (root) => {
              commandOutcome.afterReport = () =>
                republishLineProfileSoon(root, (published) => {
                  if (answered)
                    void postCommandResult(
                      siteUrl,
                      config.auth_token!,
                      commandId,
                      JSON.stringify({ ...JSON.parse(answered), published }),
                    ).catch(() => {});
                });
              return { ok: "pending" };
            },
          },
        );
        commandOutcome.result = answered = JSON.stringify(reply);
        log(
          `[CONFIG] Edited ${reply.file}${reply.changed ? "; republishing" : " (unchanged)"}`,
        );
      } catch (err) {
        commandOutcome.error = err instanceof Error ? err.message : String(err);
      }
      break;
    }
    case "line_graph_edit": {
      // The app's edit of one step of a published graph (line-workspace.md
      // LW4): the prompt or script file the .cast names, in the checkout
      // that published it, fenced, parsed before the write, written
      // atomically, then pushed again so the app's copy and its versions
      // follow. args: LineGraphEditArgs. Result: LineGraphEditReply.
      const { runLineGraphEdit } = await import("../lineGraphEdit.js");
      try {
        let answered: string | undefined;
        const reply = await runLineGraphEdit(
          commandArgs ? JSON.parse(commandArgs) : {},
          {
            admit: (file) => fencedTarget(file, "line_graph"),
            write: (file, content) =>
              atomicWriteFile(
                file,
                content,
                fs.existsSync(file) ? {} : { mode: 0o644 },
              ),
            publish: (root, castAbs) => {
              commandOutcome.afterReport = () =>
                void runCastCommand(["workflow", "push", castAbs], {
                  env: { CODECAST_CWD: root },
                  timeoutMs: 120_000,
                }).then((res) => {
                  const published =
                    res.code === 0
                      ? { ok: true }
                      : {
                          ok: false,
                          detail:
                            (res.stderr || res.stdout)
                              .trim()
                              .split("\n")
                              .pop()
                              ?.slice(0, 300) || `exit ${res.code}`,
                        };
                  if (!published.ok)
                    log(
                      `[CONFIG] Push of ${castAbs} after an edit failed: ${published.detail}`,
                    );
                  if (answered)
                    void postCommandResult(
                      siteUrl,
                      config.auth_token!,
                      commandId,
                      JSON.stringify({ ...JSON.parse(answered), published }),
                    ).catch(() => {});
                });
              return { ok: "pending" };
            },
          },
        );
        commandOutcome.result = answered = JSON.stringify(reply);
        log(
          `[CONFIG] Edited ${reply.node} in ${reply.target}${reply.changed ? "; pushing" : " (unchanged)"}`,
        );
      } catch (err) {
        commandOutcome.error = err instanceof Error ? err.message : String(err);
      }
      break;
    }
    case "line_try": {
      // Try (line-workspace.md LW4): a step's edited prompt run on past
      // cases through the dry-run harness, writes refused. The command
      // answers at once; each case reports to its line_tries row as it
      // settles. args: LineTryArgs (lineTry.ts).
      const tryMod = await import("../lineTry.js");
      try {
        const args = commandArgs ? JSON.parse(commandArgs) : {};
        if (
          typeof args.root !== "string" ||
          typeof args.file !== "string" ||
          !Array.isArray(args.cases)
        )
          throw new Error(
            "line_try needs the graph's checkout, its file and the cases",
          );
        const castAbs = await fencedTarget(
          path.join(args.root, args.file),
          "line_graph",
        );
        if (!castAbs)
          throw new Error(
            `${path.join(args.root, args.file)} is not a graph in a project this machine tracks`,
          );
        const script = tryMod.harnessScriptPath();
        if (!script)
          throw new Error(
            "Trying a step needs codecast's source on the machine that published the graph (the dry-run harness is not in this build)",
          );
        const report = (rowId: string, r: unknown) =>
          fetch(`${siteUrl}/cli/line-tries/report`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              api_token: config.auth_token,
              row_id: rowId,
              report: r,
            }),
          }).then(
            () => undefined,
            () => undefined,
          );
        void tryMod
          .runLineTry(args, {
            report,
            harness: (argv, o) =>
              tryMod.spawnHarness(argv, {
                ...o,
                env: { ...process.env, PATH: agentSpawnPath() },
              }),
            fromCheckpoint: (runId, given) =>
              tryMod.briefFromCheckpoint(
                castAbs,
                args.root,
                args.node,
                args.new_template,
                runId,
                given,
              ),
            runDir: tryMod.tryRunDir,
            harnessScript: script,
          })
          .then((t) =>
            log(
              `[LINE] Try ${args.try_id} on ${args.node}: ${t.ran} ran, ${t.not_tryable} not tryable, ${t.failed} failed`,
            ),
          );
        commandOutcome.result = JSON.stringify({ accepted: args.cases.length });
      } catch (err) {
        commandOutcome.error = err instanceof Error ? err.message : String(err);
      }
      break;
    }
    case "line_deploy": {
      // Deploy on the line (deploys.md DP2): the Line page or the line's
      // role asked for dp-N. `cast line deploy run` in the checkout that
      // publishes the line runs its steps as the line-deploy graph (DP8)
      // and reports to the deploy row; CI and an eval gate take hours, so
      // the command answers at once. args: { deploy, root }.
      try {
        const args = commandArgs ? JSON.parse(commandArgs) : {};
        if (typeof args.deploy !== "string" || !/^dp-\d+$/.test(args.deploy))
          throw new Error("line_deploy needs the deploy's ref (dp-N)");
        if (typeof args.root !== "string" || !fs.existsSync(args.root))
          throw new Error(`No checkout at ${args.root} on this machine`);
        void runCastCommand(["line", "deploy", "run", args.deploy], {
          cwd: args.root,
          env: { CODECAST_CWD: args.root },
          timeoutMs: 10 * 60 * 60 * 1000,
        }).then((r) => log(`[LINE] Deploy ${args.deploy}: exit ${r.code}`));
        commandOutcome.result = JSON.stringify({ accepted: args.deploy });
      } catch (err) {
        commandOutcome.error = err instanceof Error ? err.message : String(err);
      }
      break;
    }
    case "line_fixloop": {
      // The nightly fix trace (docs/architecture/regret.md R2): record what
      // landed on main and what each fix repaired. The checkouts only name
      // the repositories; history is read from this machine's own mirror of
      // origin. args: { team_id, roots }.
      try {
        const args = commandArgs ? JSON.parse(commandArgs) : {};
        if (
          typeof args.team_id !== "string" ||
          !Array.isArray(args.roots) ||
          args.roots.length === 0
        )
          throw new Error("line_fixloop needs team_id and roots");
        const roots = args.roots.filter(
          (r: unknown): r is string => typeof r === "string",
        );
        void runCastCommand(
          [
            "line",
            "fixloop",
            "--record",
            "--team",
            args.team_id,
            "--from",
            ...roots,
          ],
          { timeoutMs: 2 * 60 * 60 * 1000 },
        ).then((r) =>
          log(
            `[LINE] Fix trace for ${args.team_id}: exit ${r.code}${r.code ? ` ${(r.stderr || r.stdout).trim().slice(-300)}` : ""}`,
          ),
        );
        commandOutcome.result = JSON.stringify({ accepted: roots.length });
      } catch (err) {
        commandOutcome.error = err instanceof Error ? err.message : String(err);
      }
      break;
    }
    case "line_trial_reask": {
      // "Re-ask" in the line app on a trial run paused where no answer can
      // land: the same re-ask the CLI does, run here because it stops the
      // run's runner and reads its graph on this machine. args: { task, project_path? }.
      try {
        const args = commandArgs ? JSON.parse(commandArgs) : {};
        if (typeof args.task !== "string" || !/^ct-\d+$/.test(args.task))
          throw new Error("line_trial_reask needs the problem's ref");
        const cwd =
          typeof args.project_path === "string" &&
          fs.existsSync(args.project_path)
            ? args.project_path
            : undefined;
        const ran = await runCastCommand(
          ["line", "trial", "rerun", args.task, "--reask", "--json"],
          { timeoutMs: 3 * 60 * 1000, ...(cwd ? { cwd } : {}) },
        );
        if (ran.code === 0) {
          commandOutcome.result =
            ran.stdout.trim() || JSON.stringify({ task: args.task });
          log(`[LINE] Re-asked ${args.task}`);
        } else
          commandOutcome.error = (
            ran.stderr.trim() ||
            ran.stdout.trim() ||
            `cast line trial rerun exited ${ran.code}`
          ).slice(-600);
      } catch (err) {
        commandOutcome.error = err instanceof Error ? err.message : String(err);
      }
      break;
    }
  }
}
