import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { PasskeyMeta } from "@codecast/secrets/secrets";
import { AGENT_TAB_KEY } from "../../lib/desktopHandoff";
import { mountWeb } from "../../test-helpers/mountWeb";
import { testPasskeys } from "../../test-helpers/testPasskeys";
import { testToasts } from "../../test-helpers/testToasts";
import { PasskeysSection } from "./PasskeysSection";

const { ceremonies, install } = testPasskeys();
let restorePlatform: (() => void) | undefined;
beforeEach(() => {
  ceremonies.length = 0;
});
afterEach(() => {
  restorePlatform?.();
  restorePlatform = undefined;
});

const mount = (passkeys: PasskeyMeta[], agentTab = false) =>
  mountWeb(<PasskeysSection />, {
    authenticated: true,
    path: "/settings/accounts",
    setup: (backend) => {
      restorePlatform = install();
      if (agentTab) sessionStorage.setItem(AGENT_TAB_KEY, "1");
      const expires_at = Date.now() + 60_000;
      backend.set(api.passkeys.list, passkeys);
      backend.action(api.passkeys.presenceBegin, {
        challenge_id: "ch-1",
        options: { challenge: "Y2g", allowCredentials: [] },
        expires_at,
        grant: "ch-1.g",
      });
      backend.action(api.passkeys.presenceFinish, {
        granted: true,
        action: "remove_passkey",
        expires_at,
      });
      backend.action(api.passkeys.registrationBegin, {
        challenge_id: "reg-1",
        options: {
          challenge: "Y2g",
          rp: { id: "app.test", name: "Codecast" },
          user: { id: "dQ", name: "account", displayName: "Account" },
          pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        },
        expires_at,
      });
      backend.action(api.passkeys.registrationFinish, {
        id: "pk-new",
        name: "Passkey",
        first: true,
      });
      backend.mutation(api.passkeys.remove, ({ id }) => ({
        removed: true,
        id,
      }));
    },
  });

describe("PasskeysSection", () => {
  test("lists each passkey; Remove asks for Touch ID, then removes it", async () => {
    const passkey = {
      _id: "pk-1",
      name: "Chrome on Mac",
      created_at: Date.now() - 3 * 86_400_000,
      last_used_at: Date.now() - 60_000,
    };
    const { backend, container } = await mount([passkey]);
    const row = container.querySelector("[data-passkey='pk-1']")!;
    expect(row.querySelector("[data-passkey-name]")!.textContent).toBe(
      passkey.name,
    );
    expect(row.textContent).toContain("added 3d ago");
    const toasts = testToasts();
    await act(() =>
      row.querySelector<HTMLButtonElement>("[data-passkey-remove]")!.click(),
    );
    expect(backend.actions.map(({ name }) => name)).toEqual([
      "passkeys:presenceBegin",
      "passkeys:presenceFinish",
    ]);
    expect(backend.actions[0]?.args).toMatchObject({
      action: "remove_passkey",
      target: passkey._id,
    });
    expect(backend.mutations).toEqual([
      { name: "passkeys:remove", args: { id: passkey._id, grant: "ch-1.g" } },
    ]);
    expect(ceremonies).toEqual(["get"]);
    expect(toasts.read().filter(({ type }) => type === "error")).toEqual([]);
  });

  test("with none, Add sets up the first passkey with no Touch ID to assert", async () => {
    const { backend, container } = await mount([]);
    expect(container.querySelector("[data-passkeys-empty]")).not.toBeNull();
    const toasts = testToasts();
    await act(() =>
      container.querySelector<HTMLButtonElement>("[data-passkey-add]")!.click(),
    );
    expect(backend.actions.map(({ name }) => name)).toEqual([
      "passkeys:registrationBegin",
      "passkeys:registrationFinish",
    ]);
    expect(ceremonies).toEqual(["create"]);
    expect(toasts.read().filter(({ type }) => type === "error")).toEqual([]);
  });

  test("in an agent's tab, Add is held", async () => {
    const { container } = await mount([], true);
    const add =
      container.querySelector<HTMLButtonElement>("[data-passkey-add]")!;
    expect(add.disabled).toBe(true);
    expect(add.title).toBe("A person sets up Touch ID");
  });
});
