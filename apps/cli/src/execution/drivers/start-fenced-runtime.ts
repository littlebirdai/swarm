import * as path from "node:path";
import type { AgentClientId } from "@codecast/agent-clients/agentClients";
import type {
  ExecutionTargetSpec,
  RuntimeConfiguration,
} from "@codecast/agent-clients/executionBinding";
import type { AttachedFileRef } from "@codecast/daemon/fileAttachment";
import {
  createCodexOwnedPilot,
  type CodexOwnedPilot,
} from "../codex-owned-pilot.js";
import {
  registerCodexExecutionDriver,
  type PilotOptions,
} from "../codex-pilot-settings.js";
import type { ExecutionConvexTransport } from "../convexControlPlane.js";
import { RuntimeDriverRegistry } from "../driver.js";
import {
  FENCED_TMUX_TAG_NAMES,
  ManagedTmuxRuntimeDriver,
  type FencedTmuxTags,
} from "./managedTmux.js";
import {
  DaemonExecutionRuntime,
  getProcessExecutionRuntime,
} from "../runtime-rail.js";

export type FencedRuntimeHost = {
  transport: ExecutionConvexTransport;
  ownerDeviceId: string;
  configDir: string;
  siteUrl: string;
  bearer?: string;
  codexCommand: PilotOptions["command"];
  codexPermissions: PilotOptions["permissions"];
  codexInstructions: PilotOptions["instructions"];
  display: PilotOptions["display"];
  tmux: {
    sizeArgs: readonly string[];
    exec: (args: string[]) => Promise<{ stdout: string }>;
    setSessionOption: (
      session: string,
      name: string,
      value: string,
    ) => Promise<void>;
    getSessionOption: (session: string, name: string) => Promise<string | null>;
    typeIntoPane: (target: string, text: string) => Promise<void>;
    injectDelivery: (params: {
      tmuxTarget: string;
      agent: AgentClientId;
      text: string;
    }) => Promise<void>;
    killSessionAndTree: (session: string) => Promise<void>;
  };
  buildTmuxLaunchCommand: (
    target: ExecutionTargetSpec,
    configuration: RuntimeConfiguration,
  ) => string;
  codexAppServer?: Parameters<typeof registerCodexExecutionDriver>[2];
  resolveImage: (storageId: string) => Promise<string | null>;
  resolveFile: (ref: AttachedFileRef) => Promise<string | null>;
  log: (message: string) => void;
};

export async function startFencedExecutionRuntime(
  host: FencedRuntimeHost,
): Promise<{
  codexOwnedPilot: CodexOwnedPilot | undefined;
  fencedRuntime: DaemonExecutionRuntime;
}> {
  const codexOwnedPilot = createCodexOwnedPilot({
    siteUrl: host.siteUrl,
    bearer: host.bearer,
    command: host.codexCommand,
    permissions: host.codexPermissions,
    instructions: host.codexInstructions,
    display: host.display,
    log: host.log,
  });

  const registry = new RuntimeDriverRegistry();
  registry.register(
    new ManagedTmuxRuntimeDriver({
      io: {
        async createSession({ tmuxSession, cwd }) {
          await host.tmux.exec([
            "new-session",
            "-d",
            ...host.tmux.sizeArgs,
            "-s",
            tmuxSession,
            "-c",
            cwd,
          ]);
        },
        async setSessionOption({ tmuxSession, name, value }) {
          await host.tmux.setSessionOption(tmuxSession, name, value);
        },
        async launchLiteral({ tmuxSession, command }) {
          await host.tmux.typeIntoPane(`${tmuxSession}:0.0`, command);
        },
        async listCandidates({ expectedTmuxSession }) {
          let names: string[];
          try {
            const { stdout } = await host.tmux.exec([
              "list-sessions",
              "-F",
              "#{session_name}",
            ]);
            names = stdout
              .split("\n")
              .map((name) => name.trim())
              .filter(Boolean);
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            if (/no server running|failed to connect to server/i.test(message))
              return [];
            throw error;
          }
          const candidates = [];
          for (const tmuxSession of names) {
            if (
              tmuxSession !== expectedTmuxSession &&
              !tmuxSession.startsWith("cc-f1-")
            )
              continue;
            const tags: Partial<FencedTmuxTags> = {};
            for (const [key, name] of Object.entries(
              FENCED_TMUX_TAG_NAMES,
            ) as Array<[keyof FencedTmuxTags, string]>) {
              const value = await host.tmux.getSessionOption(tmuxSession, name);
              if (value !== null) tags[key] = value;
            }
            candidates.push({
              tmuxSession,
              tmuxTarget: `${tmuxSession}:0.0`,
              alive: true,
              tags,
            });
          }
          return candidates;
        },
        async injectDelivery({ tmuxTarget, agent, delivery }) {
          const text = delivery.input
            .map((item) =>
              item.type === "text" ? item.text : `[Image ${item.path}]`,
            )
            .filter(Boolean)
            .join("\n");
          await host.tmux.injectDelivery({ tmuxTarget, agent, text });
          return { state: "delivered" as const };
        },
        async stopSession(tmuxSession) {
          await host.tmux.killSessionAndTree(tmuxSession);
        },
        async quarantineSession(tmuxSession) {
          await host.tmux.killSessionAndTree(tmuxSession);
        },
      },
      buildLaunch(target, configuration) {
        return {
          command: host.buildTmuxLaunchCommand(target, configuration),
        };
      },
    }),
  );

  if (host.codexAppServer) {
    registerCodexExecutionDriver(
      registry,
      codexOwnedPilot,
      host.codexAppServer,
    );
  }

  const fencedRuntime = getProcessExecutionRuntime({
    transport: host.transport,
    ownerDeviceId: host.ownerDeviceId,
    codexOwnedPilot,
    journalDirectory: path.join(host.configDir, "execution-journal"),
    drivers: registry,
    resolveImage: host.resolveImage,
    resolveFile: host.resolveFile,
    onLog: host.log,
  });

  host.log(
    `[fenced-execution] enabled protocol=1 boot=${fencedRuntime.daemonBootId}`,
  );
  await fencedRuntime.start();
  return { codexOwnedPilot, fencedRuntime };
}
