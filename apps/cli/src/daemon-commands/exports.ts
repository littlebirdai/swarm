import { claudeProjectsDirs } from "../claudeConfigDirs.js";
import type { CommandOutcome, DaemonCommandDeps } from "./dependencies.js";

export async function handleExportCommand(
  daemon: Pick<DaemonCommandDeps, "log" | "syncServiceRef">,
  commandOutcome: CommandOutcome,
  command: string,
  commandArgs: string | undefined,
): Promise<void> {
  const { log } = daemon;
  switch (command) {
    case "export_folder": {
      const svc = daemon.syncServiceRef;
      if (!svc) {
        commandOutcome.error = "export_folder: not connected";
        break;
      }
      const { exportFolder, FOLDER_BUNDLE_MEDIA_TYPE } =
        await import("../folderSync.js");
      const parsed = commandArgs ? JSON.parse(commandArgs) : {};
      const out = await exportFolder(parsed, {
        home: process.env.HOME || require("os").homedir(),
        upload: (bytes) =>
          svc.uploadBytes(
            bytes,
            FOLDER_BUNDLE_MEDIA_TYPE,
            "Folder",
            5 * 60_000,
          ),
        log,
        onGrantDone: (g) =>
          log(
            `[FOLDER] direct link for ${parsed.path} closed: ${g.reason} (${g.bytes} bytes)`,
          ),
      });
      commandOutcome.result = JSON.stringify(out);
      const how = out.ok
        ? "direct" in out
          ? `granted a direct link on ${out.direct.ip}:${out.direct.port}`
          : "sent through the relay"
        : out.reason;
      log(
        `[FOLDER] export_folder ${parsed.path}: ${how}${"direct_skipped" in out && out.direct_skipped ? ` (direct skipped: ${out.direct_skipped})` : ""}`,
      );
      break;
    }
    case "export_session": {
      const svc = daemon.syncServiceRef;
      if (!svc) {
        commandOutcome.error = "export_session: not connected";
        break;
      }
      const { FOLDER_BUNDLE_MEDIA_TYPE } = await import("../folderSync.js");
      const { exportSession } = await import("../sessionTransfer.js");
      const parsed = commandArgs ? JSON.parse(commandArgs) : {};
      const home = process.env.HOME || require("os").homedir();
      const out = await exportSession(parsed, {
        home,
        projectsDirs: claudeProjectsDirs(home),
        upload: (bytes) =>
          svc.uploadBytes(
            bytes,
            FOLDER_BUNDLE_MEDIA_TYPE,
            "Transcript",
            5 * 60_000,
          ),
        log,
        onGrantDone: (g) =>
          log(
            `[SESSION] direct link for ${parsed.conversation_id} closed: ${g.reason} (${g.bytes} bytes)`,
          ),
      });
      commandOutcome.result = JSON.stringify(out);
      log(
        `[SESSION] export_session ${parsed.conversation_id}: ${out.ok ? ("direct" in out ? "granted a direct link" : "sent through the relay") : out.reason}`,
      );
      break;
    }
  }
}
