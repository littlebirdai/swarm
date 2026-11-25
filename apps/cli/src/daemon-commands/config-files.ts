import * as fs from "fs";
import * as path from "path";
import {
  withHarnessCause,
  writeHarnessFile,
  removeHarnessFile,
} from "../harness.js";
import { configDirTarget } from "../configFence.js";
import type { CommandOutcome, DaemonCommandDeps } from "./dependencies.js";

export async function handleConfigCommand(
  daemon: Pick<
    DaemonCommandDeps,
    "EDITED_IN_CODECAST" | "fencedTarget" | "log" | "validatePath"
  >,
  commandOutcome: CommandOutcome,
  command: string,
  commandArgs: string | undefined,
): Promise<void> {
  const { EDITED_IN_CODECAST, fencedTarget, log, validatePath } = daemon;
  switch (command) {
    case "config_list": {
      const home = process.env.HOME || "";
      const claudeDir = path.join(home, ".claude");
      const codexDir = path.join(home, ".codex");

      type ConfigFile = {
        path: string;
        type: string;
        label: string;
        tool: string;
      };
      const files: ConfigFile[] = [];

      const addFile = (
        filePath: string,
        type: string,
        label: string,
        tool: string,
      ) => {
        if (fs.existsSync(filePath))
          files.push({ path: filePath, type, label, tool });
      };

      const addDir = (dir: string, type: string, tool: string) => {
        if (!fs.existsSync(dir)) return;
        try {
          for (const f of fs.readdirSync(dir)) {
            const fullPath = path.join(dir, f);
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
              // Skills are directories containing SKILL.md
              const skillFile = path.join(fullPath, "SKILL.md");
              if (fs.existsSync(skillFile)) {
                files.push({ path: skillFile, type, label: f, tool });
              }
            } else if (
              f.endsWith(".md") ||
              f.endsWith(".json") ||
              f.endsWith(".toml")
            ) {
              files.push({
                path: fullPath,
                type,
                label: f.replace(/\.(md|json|toml)$/, ""),
                tool,
              });
            }
          }
        } catch {}
      };

      // Claude global files
      addFile(
        path.join(claudeDir, "CLAUDE.md"),
        "instructions",
        "Global CLAUDE.md",
        "claude",
      );
      addFile(
        path.join(claudeDir, "settings.json"),
        "settings",
        "settings.json",
        "claude",
      );
      addFile(
        path.join(claudeDir, "settings.local.json"),
        "settings",
        "settings.local.json",
        "claude",
      );
      addFile(
        path.join(claudeDir, "keybindings.json"),
        "keybindings",
        "keybindings.json",
        "claude",
      );
      addDir(path.join(claudeDir, "agents"), "agent", "claude");
      addDir(path.join(claudeDir, "commands"), "command", "claude");
      addDir(path.join(claudeDir, "skills"), "skill", "claude");
      addDir(path.join(claudeDir, "prompts"), "prompt", "claude");

      // Codex global files
      addFile(
        path.join(codexDir, "AGENTS.md"),
        "instructions",
        "Global AGENTS.md",
        "codex",
      );
      addFile(
        path.join(codexDir, "AGENTS.override.md"),
        "instructions",
        "AGENTS.override.md",
        "codex",
      );
      addFile(
        path.join(codexDir, "config.toml"),
        "settings",
        "config.toml",
        "codex",
      );
      addDir(path.join(codexDir, "prompts"), "command", "codex");
      addDir(path.join(codexDir, "skills"), "skill", "codex");
      if (fs.existsSync(path.join(codexDir, "rules"))) {
        for (const f of fs.readdirSync(path.join(codexDir, "rules"))) {
          files.push({
            path: path.join(codexDir, "rules", f),
            type: "rules",
            label: f,
            tool: "codex",
          });
        }
      }

      // Per-project files from known project paths
      const args_parsed = commandArgs ? JSON.parse(commandArgs) : {};
      const projectPaths: string[] = args_parsed.project_paths || [];
      for (const pp of projectPaths) {
        const p = validatePath(pp);
        if (!p) continue;
        const name = path.basename(p);
        addFile(
          path.join(p, "CLAUDE.md"),
          "project_instructions",
          `${name}/CLAUDE.md`,
          "claude",
        );
        addFile(
          path.join(p, "AGENTS.md"),
          "project_instructions",
          `${name}/AGENTS.md`,
          "codex",
        );
        addFile(
          path.join(p, ".claude", "settings.json"),
          "project_settings",
          `${name}/.claude/settings.json`,
          "claude",
        );
        addFile(
          path.join(p, ".claude", "settings.local.json"),
          "project_settings",
          `${name}/.claude/settings.local.json`,
          "claude",
        );
        addFile(
          path.join(p, ".mcp.json"),
          "mcp",
          `${name}/.mcp.json`,
          "claude",
        );
        addFile(
          path.join(p, ".codex", "config.toml"),
          "project_settings",
          `${name}/.codex/config.toml`,
          "codex",
        );
        addDir(path.join(p, ".claude", "agents"), "project_agent", "claude");
        addDir(path.join(p, ".claude", "skills"), "project_skill", "claude");
        addDir(
          path.join(p, ".claude", "commands"),
          "project_command",
          "claude",
        );
      }

      commandOutcome.result = JSON.stringify(files);
      break;
    }
    case "config_read": {
      const { file_path: readPath } = commandArgs
        ? JSON.parse(commandArgs)
        : {};
      if (!readPath || typeof readPath !== "string") {
        commandOutcome.error = "Missing file_path";
        break;
      }
      // The fence (configFence.ts), "read": what the writers admit, plus an
      // agent config basename anywhere (config_list advertises project files).
      const readTarget = await fencedTarget(readPath, "read");
      if (!readTarget) {
        commandOutcome.error = "Path not allowed";
        break;
      }
      if (!fs.existsSync(readTarget)) {
        commandOutcome.result = JSON.stringify({
          content: null,
          exists: false,
        });
      } else {
        const content = fs.readFileSync(readTarget, "utf-8");
        commandOutcome.result = JSON.stringify({ content, exists: true });
      }
      break;
    }
    case "config_write": {
      const { file_path: writePath, content: writeContent } = commandArgs
        ? JSON.parse(commandArgs)
        : {};
      if (
        !writePath ||
        typeof writePath !== "string" ||
        typeof writeContent !== "string"
      ) {
        commandOutcome.error = "Missing file_path or content";
        break;
      }
      // The fence (configFence.ts): this user's ~/.claude and ~/.codex and
      // agent config basenames inside a tracked project root, nothing else,
      // all on the canonical path. A line profile is line_profile_edit's alone.
      const realTarget = await fencedTarget(writePath, "config");
      if (!realTarget) {
        commandOutcome.error = "Path not allowed";
        break;
      }
      // A file the capability materializer owns keys for is written through
      // its ledger, never over it: a raw whole-file write here would clobber
      // owned keys and orphan the ledger, voiding the ownership argument the
      // materializer rests on. The caller can pass override_owned after
      // showing the user the conflict.
      const { readLedger } = await import("../capabilities/ownedJson.js");
      const parsedArgs = commandArgs ? JSON.parse(commandArgs) : {};
      if (
        Object.keys(readLedger(realTarget)).length > 0 &&
        !parsedArgs.override_owned
      ) {
        commandOutcome.error =
          "File carries capability-managed keys; pass override_owned to replace it wholesale";
        break;
      }
      withHarnessCause(EDITED_IN_CODECAST, () =>
        writeHarnessFile(realTarget, writeContent, "edit"),
      );
      commandOutcome.result = JSON.stringify({ success: true });
      log(`[CONFIG] Wrote ${realTarget}`);
      break;
    }
    case "config_create": {
      const {
        dir_path,
        filename,
        content: createContent = "",
      } = commandArgs ? JSON.parse(commandArgs) : {};
      if (!dir_path || !filename) {
        commandOutcome.error = "Missing dir_path or filename";
        break;
      }
      const resolvedDir = configDirTarget(dir_path, process.env.HOME || "");
      if (!resolvedDir) {
        commandOutcome.error = "Dir not allowed";
        break;
      }
      if (!/^[a-zA-Z0-9_-]+\.(md|json|toml)$/.test(filename)) {
        commandOutcome.error = "Invalid filename";
        break;
      }
      const newPath = path.join(resolvedDir, filename);
      if (fs.existsSync(newPath)) {
        commandOutcome.error = "File already exists";
        break;
      }
      fs.mkdirSync(resolvedDir, { recursive: true });
      withHarnessCause(EDITED_IN_CODECAST, () =>
        writeHarnessFile(newPath, createContent, "edit"),
      );
      commandOutcome.result = JSON.stringify({ success: true, path: newPath });
      log(`[CONFIG] Created ${newPath}`);
      break;
    }
    case "config_delete": {
      const { file_path: deletePath } = commandArgs
        ? JSON.parse(commandArgs)
        : {};
      if (!deletePath || typeof deletePath !== "string") {
        commandOutcome.error = "Missing file_path";
        break;
      }
      const resolved = configDirTarget(deletePath, process.env.HOME || "", {
        inside: true,
      });
      if (!resolved) {
        commandOutcome.error =
          "Only files in agents/commands/skills/prompts dirs can be deleted";
        break;
      }
      if (!fs.existsSync(resolved)) {
        commandOutcome.error = "File not found";
        break;
      }
      withHarnessCause(EDITED_IN_CODECAST, () =>
        removeHarnessFile(resolved, "edit"),
      );
      commandOutcome.result = JSON.stringify({ success: true });
      log(`[CONFIG] Deleted ${resolved}`);
      break;
    }
  }
}
