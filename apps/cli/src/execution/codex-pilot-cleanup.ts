import type { ReadyBinding } from "@codecast/agent-clients/executionBinding";
import type {
  ProviderAdapterClient,
  ProviderOwnedSession,
} from "@codecast/provider-adapter";
import type { PilotOptions } from "./codex-pilot-settings.js";

export async function reportPilotFailure(
  display: PilotOptions["display"],
  log: (message: string) => void,
  binding: ReadyBinding,
  message: string,
): Promise<void> {
  display.sendAgentStatus(
    display.syncService,
    binding.conversationId,
    binding.runtimeId,
    "stopped",
  );
  await display.syncService
    .setSessionError(binding.conversationId, message, { force: true })
    .catch((error) => {
      log(`[owned-codex] session error update failed: ${String(error)}`);
    });
}

export async function closeOwnedProvider(
  log: (message: string) => void,
  session: ProviderOwnedSession | undefined,
  adapter: ProviderAdapterClient | undefined,
) {
  async function cleanup<T>(name: string, step: () => T | Promise<T>) {
    try {
      return await step();
    } catch (error) {
      log(`[owned-codex] ${name} failed: ${String(error)}`);
    }
  }
  const outcome = await cleanup("provider close", () => session?.close());
  const disposed = await cleanup("adapter disposal", async () => {
    await adapter?.dispose();
    return true;
  });
  const stopped =
    !session ||
    outcome?.status === "closed" ||
    (await cleanup("process exit confirmation", () => session.processGone?.()));
  return { disposed, stopped, cleanup };
}

export async function closePilots(
  pilots: readonly { close(): Promise<void> }[],
) {
  const results = await Promise.allSettled(
    pilots.map((pilot) => pilot.close()),
  );
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
}
