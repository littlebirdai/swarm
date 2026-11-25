import * as fs from "fs";
import { isRemoteDevice } from "../remote/device.js";
import {
  verifyActiveIdentity,
  saveProfile,
  deleteProfile,
  removeAccountToken,
} from "../ccAccounts.js";
import { resolveCodexAccount } from "../codexAccounts.js";
import { redeemCodexResetCredit } from "../codexResetCredit.js";
import { submitApprovalCode } from "../mintFlowControl.js";
import {
  decryptProviderKeyPayload,
  applyProviderKeyCommand,
} from "../providerKeyCrypto.js";
import type { CommandOutcome, DaemonCommandDeps } from "./dependencies.js";
import { switchAccount } from "./switch-account.js";

export async function handleAccountCommand(
  daemon: Pick<
    DaemonCommandDeps,
    | "CONFIG_DIR"
    | "FLEET_REREAD_WAIT_MS"
    | "MINT_FLOW_TMUX"
    | "SWITCH_CONTINUE_SPACING_MS"
    | "accountLifecycleGate"
    | "buildReverseConversationCache"
    | "findSessionProcess"
    | "killConversationBackends"
    | "killTmuxSessionAndTree"
    | "log"
    | "maintainCcUsageSnapshots"
    | "maintainCodexUsageSnapshot"
    | "mintFlow"
    | "mintUrlPath"
    | "pacedAccountRevive"
    | "pushCredentialToRemoteHosts"
    | "pushProviderKeysToRemoteHosts"
    | "readConfig"
    | "readConversationCache"
    | "sendHeartbeat"
    | "startLoginFlow"
    | "startMintFlow"
    | "submitLoginCode"
    | "syncServiceRef"
    | "tmuxExec"
    | "verifyProviderKey"
  >,
  commandOutcome: CommandOutcome,
  commandId: string,
  command: string,
  commandArgs: string | undefined,
): Promise<void> {
  const {
    CONFIG_DIR,
    MINT_FLOW_TMUX,
    killTmuxSessionAndTree,
    log,
    maintainCcUsageSnapshots,
    maintainCodexUsageSnapshot,
    mintFlow,
    mintUrlPath,
    pushProviderKeysToRemoteHosts,
    readConfig,
    sendHeartbeat,
    startLoginFlow,
    startMintFlow,
    submitLoginCode,
    tmuxExec,
    verifyProviderKey,
  } = daemon;
  switch (command) {
    // Swap the machine's active Claude Code account to a saved profile, then
    // recycle the listed blocked sessions so they resume on the new account.
    // Order matters: kill BEFORE enqueueing the continues — a still-alive
    // claude process holds the old account's token in memory, so injecting
    // first would just re-hit the old account's limit. The pending "continue"
    // is what triggers the auto-resume that reads the fresh credential.
    case "switch_account": {
      const parsed = commandArgs ? JSON.parse(commandArgs) : {};
      const profile: string | undefined =
        typeof parsed.profile === "string" && parsed.profile
          ? parsed.profile
          : undefined;
      const conversationIds: string[] = Array.isArray(parsed.conversation_ids)
        ? parsed.conversation_ids
        : [];
      // Parked sessions on the fleet store: the switch moves them with the
      // store, so they get only the continue, once Claude Code has re-read it.
      const followIds: string[] = Array.isArray(parsed.follow_ids)
        ? parsed.follow_ids
        : [];
      const sessionIds: Record<string, string> =
        parsed.session_ids && typeof parsed.session_ids === "object"
          ? parsed.session_ids
          : {};
      const sendContinue: boolean = parsed.continue_blocked !== false;
      // The web paints its "continue" bubble the moment the user clicks and
      // sends the client_id it painted with along the command. Enqueueing
      // under that id makes the server echo REPLACE that bubble instead of
      // adding a second one. Absent for server-initiated revives.
      const continueClientIds: Record<string, string> =
        parsed.client_ids && typeof parsed.client_ids === "object"
          ? parsed.client_ids
          : {};

      // A mass continue paces one resume every 20s. Moving the fleet in the
      // middle of that pace is how a click onto an empty account lasted
      // thirty seconds and the continues came back on the spent one.
      if (
        profile &&
        daemon.pacedAccountRevive &&
        daemon.pacedAccountRevive.profile !== profile
      ) {
        log(
          `[ACCOUNTS] not moving the fleet to "${profile}": paced continues are still going out on "${daemon.pacedAccountRevive.profile}"`,
        );
        commandOutcome.result = JSON.stringify({
          switched: null,
          killed: 0,
          continued: 0,
          held_for: daemon.pacedAccountRevive.profile,
        });
        break;
      }

      // save_as mode: snapshot the CURRENT login as a named profile (the web
      // Settings "save as profile" button). Pure save — no swap, no kills.
      if (typeof parsed.save_as === "string" && parsed.save_as) {
        try {
          await verifyActiveIdentity();
          const meta = saveProfile(parsed.save_as);
          commandOutcome.result = JSON.stringify({
            saved: meta.name,
            email: meta.email ?? null,
          });
          log(
            `[ACCOUNTS] Saved active account as profile "${meta.name}"${meta.email ? ` (${meta.email})` : ""}`,
          );
          // Push the refreshed profile inventory upstream now — the Settings
          // page is watching for it; don't make it wait a heartbeat cycle.
          sendHeartbeat().catch(() => {});
        } catch (err) {
          commandOutcome.error = `Profile save failed: ${err instanceof Error ? err.message : String(err)}`;
        }
        break;
      }

      // remove mode: forget a saved profile (the web Settings remove
      // button). Pure deletion — no swap, no kills. deleteProfile guards the
      // active login (auto-enroll would resurrect it a heartbeat later).
      if (typeof parsed.remove === "string" && parsed.remove) {
        try {
          const meta = deleteProfile(parsed.remove);
          commandOutcome.result = JSON.stringify({
            removed: parsed.remove,
            email: meta.email ?? null,
          });
          log(
            `[ACCOUNTS] Removed profile "${parsed.remove}"${meta.email ? ` (${meta.email})` : ""}`,
          );
          // Confirm the shrunken inventory upstream now — the web already
          // hid the row optimistically and is waiting on this echo.
          sendHeartbeat().catch(() => {});
        } catch (err) {
          commandOutcome.error = `Profile remove failed: ${err instanceof Error ? err.message : String(err)}`;
        }
        break;
      }

      // refresh_usage mode: the web's refresh button. Probe every account's
      // usage now (both providers), then heartbeat so the meters move
      // before the command's caller stops watching.
      if (parsed.refresh_usage === true) {
        await Promise.all([
          maintainCcUsageSnapshots("manual", { force: true }),
          maintainCodexUsageSnapshot("manual", { force: true }),
        ]);
        await sendHeartbeat().catch(() => {});
        commandOutcome.result = JSON.stringify({ refreshed: true });
        break;
      }

      if (parsed.cancel_mint === true) {
        commandOutcome.result = await mintFlow.run(async () => {
          if (!mintFlow.cancel(parsed.mint_started_at))
            return "mint_flow_already_ended";
          await killTmuxSessionAndTree(MINT_FLOW_TMUX).catch(() => {});
          fs.rmSync(mintUrlPath(), { force: true });
          return "mint_flow_cancelled";
        });
        break;
      }

      if (parsed.mint_code) {
        commandOutcome.result = await mintFlow.run(async () => {
          if (!mintFlow.active || mintFlow.startedAt !== parsed.mint_started_at)
            throw new Error("This mint has ended. Start again.");
          await submitApprovalCode(
            (args) => tmuxExec(args, { timeout: 3000 }),
            MINT_FLOW_TMUX,
            decryptProviderKeyPayload(CONFIG_DIR, parsed.mint_code),
          );
          return "mint_code_submitted";
        });
        break;
      }

      // mint mode: mint a setup-token for ONE saved profile (the web's
      // guided "mint a token"). Returns at once — the flow takes as long as
      // the person's browser dance, far past any command TTL — and the
      // watcher reports the outcome through reportMintFlow (see MINT-FLOW).
      if (typeof parsed.mint === "string" && parsed.mint) {
        try {
          commandOutcome.result = await startMintFlow(
            parsed.mint,
            parsed.force === true,
            parsed.mint_started_at,
          );
        } catch (err) {
          commandOutcome.error = `Mint launch failed: ${err instanceof Error ? err.message : String(err)}`;
          daemon.syncServiceRef
            ?.reportMintFlow(
              "rejected",
              parsed.mint,
              undefined,
              commandOutcome.error,
              undefined,
              parsed.mint_started_at,
            )
            .catch(() => {});
        }
        break;
      }

      // remove_token mode: forget a profile's minted token; its sessions
      // fall back to the credential store on the next launch.
      if (typeof parsed.remove_token === "string" && parsed.remove_token) {
        try {
          const existed = removeAccountToken(parsed.remove_token);
          log(
            `[MINT-FLOW] token for "${parsed.remove_token}" ${existed ? "removed" : "was not on file"}`,
          );
          sendHeartbeat().catch(() => {});
          commandOutcome.result = JSON.stringify({ removed: existed });
        } catch (err) {
          commandOutcome.error = `Remove failed: ${err instanceof Error ? err.message : String(err)}`;
        }
        break;
      }

      // codex_reset_credit mode: spend one of the active ChatGPT account's
      // rate-limit reset credits INSTEAD of switching accounts (ct-49529),
      // then fall through to the ordinary no-switch revive so the parked
      // sessions resume on the same account with clear windows.
      //
      // The server proposes; this machine decides. The config flag is
      // re-read here because the device row it was reported through can be
      // minutes stale, and the credit is spent from this machine's login.
      // Any refusal breaks out with nothing killed and nothing continued —
      // the sessions stay parked, and the loop's follow-up check falls
      // through to a real switch.
      if (parsed.codex_reset_credit) {
        const requested: string | undefined =
          typeof parsed.codex_reset_credit.profile === "string"
            ? parsed.codex_reset_credit.profile
            : undefined;
        if (readConfig()?.codex_reset_credit_auto !== true) {
          commandOutcome.error =
            "Codex reset-credit redemption is off on this machine (config codex_reset_credit_auto)";
          log(`[ACCOUNTS] Refused reset-credit redeem: not enabled in config`);
          break;
        }
        try {
          const target = resolveCodexAccount(requested);
          if (!target.active) {
            commandOutcome.error = `Codex profile "${requested}" is not the active login — a credit is only worth spending on the account the parked sessions run`;
            break;
          }
          const outcome = await redeemCodexResetCredit({
            account: target.account,
            codexHomeDir: target.home,
            readWindows: () => {
              const fresh = resolveCodexAccount(requested).usage;
              return { session: fresh?.session, weekly: fresh?.weekly };
            },
          });
          commandOutcome.result = JSON.stringify(outcome);
          if (outcome.status !== "redeemed" || outcome.outcome !== "reset") {
            log(
              `[ACCOUNTS] Reset credit not spent for "${target.name ?? target.account}": ` +
                (outcome.status === "refused"
                  ? outcome.reason
                  : outcome.outcome),
            );
            break;
          }
          log(
            `[ACCOUNTS] Redeemed a Codex reset credit for "${target.name ?? target.account}" — windows cleared`,
          );
          // Re-probe now: the server holds off judging this account until a
          // snapshot fetched after the redeem lands, exactly as after a switch.
          maintainCodexUsageSnapshot("codex_reset_credit", { force: true })
            .then(() => sendHeartbeat())
            .catch(() => {});
        } catch (err) {
          commandOutcome.error = `Codex reset-credit redeem failed: ${err instanceof Error ? err.message : String(err)}`;
          break;
        }
      }

      await switchAccount(
        daemon,
        commandOutcome,
        commandId,
        profile,
        followIds,
        conversationIds,
        sessionIds,
        sendContinue,
        continueClientIds,
      );
      break;
    }
    // Web sign-in CTA: run the browser OAuth flow via `claude auth login` and
    // report the outcome through completeLoginFlow (see the LOGIN-FLOW block).
    // Returns immediately — the flow takes as long as the user's browser
    // dance, far past any command TTL, so a detached watcher owns the rest.
    case "start_login": {
      if (isRemoteDevice()) {
        commandOutcome.error =
          "Remote devices run a pushed copy of the primary's credential — sign in on the primary machine";
        break;
      }
      const parsed = commandArgs ? JSON.parse(commandArgs) : {};
      const email: string | undefined =
        typeof parsed.email === "string" && parsed.email
          ? parsed.email
          : undefined;
      // A profile sign-in repairs one saved login in its own store; the
      // machine's keychain login stays as it is.
      const profile: string | undefined =
        typeof parsed.profile === "string" &&
        /^[a-z0-9][a-z0-9._-]{0,40}$/i.test(parsed.profile)
          ? parsed.profile
          : undefined;
      // The approval code from the code-paste page, typed into the waiting CLI.
      if (typeof parsed.login_code === "string") {
        try {
          commandOutcome.result = await submitLoginCode(parsed.login_code);
        } catch (err) {
          commandOutcome.error =
            err instanceof Error ? err.message : String(err);
        }
        break;
      }
      try {
        commandOutcome.result = await startLoginFlow(
          email,
          parsed.force === true,
          profile,
          parsed.open_browser !== false,
        );
      } catch (err) {
        commandOutcome.error = `Sign-in launch failed: ${err instanceof Error ? err.message : String(err)}`;
        // The web is watching cc_login_flow, not command errors — report the
        // failure there too so the CTA comes back instead of spinning.
        daemon.syncServiceRef
          ?.completeLoginFlow("rejected", email, commandOutcome.error, profile)
          .catch(() => {});
      }
      break;
    }
    case "set_provider_key": {
      // Web set/removed a managed provider key for THIS device (pl-207). A "set"
      // arrives SEALED to this device's ECDH public key — Convex never saw
      // plaintext. applyProviderKeyCommand decrypts + updates the 0600 store; we
      // then fan out to remotes and heartbeat so managed_provider_ids round-trips.
      const applied = await applyProviderKeyCommand(
        CONFIG_DIR,
        commandArgs,
        verifyProviderKey,
      );
      if (!applied.ok) {
        commandOutcome.error = applied.error;
        break;
      }
      log(
        `[KEYS] ${applied.op} ${applied.provider} (web)${applied.account ? ` for ${applied.account}` : ""}`,
      );
      const { ok: _ok, ...verdict } = applied;
      commandOutcome.result = JSON.stringify(verdict);
      pushProviderKeysToRemoteHosts("web set").catch(() => {});
      await sendHeartbeat().catch(() => {});
      break;
    }
  }
}
