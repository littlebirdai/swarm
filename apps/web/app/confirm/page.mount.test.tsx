import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@codecast/convex/convex/_generated/api";
import { mountWeb } from "../../test-helpers/mountWeb";
import { testPasskeys } from "../../test-helpers/testPasskeys";
import { testToasts } from "../../test-helpers/testToasts";
import { AGENT_TAB_KEY } from "../../lib/desktopHandoff";
import ConfirmPage from "./page";

const { ceremonies, install, assertion } = testPasskeys();

type Challenge = FunctionReturnType<typeof api.passkeys.challenge>;
const PENDING = {
  purpose: "presence",
  status: "pending",
  action: "approve",
  label: "Let jx7 read STRIPE_KEY?",
  expires_at: Date.now() + 60_000,
  options: {
    challenge: "Y2g",
    rpId: "codecast.sh",
    allowCredentials: [],
    userVerification: "required",
  },
} satisfies NonNullable<Challenge>;

const mount = (challenge: Challenge, agentTab = false) =>
  mountWeb(<ConfirmPage />, {
    path: "/confirm?c=ch-7",
    setup: (backend) => {
      const restore = install();
      restorePlatform ??= restore;
      if (agentTab) sessionStorage.setItem(AGENT_TAB_KEY, "1");
      backend.set(api.passkeys.challenge, challenge);
      backend.action(api.passkeys.presenceFinish, {
        granted: true,
        action: "approve",
        expires_at: 1,
      });
      backend.action(api.passkeys.registrationFinish, {
        id: "AQ",
        name: "Touch ID",
        first: true,
      });
    },
  });

let restorePlatform: (() => void) | undefined;
beforeEach(() => {
  ceremonies.length = 0;
});
afterEach(() => {
  restorePlatform?.();
  restorePlatform = undefined;
});

describe("/confirm", () => {
  test("a pending presence challenge confirms with an assertion, signed out", async () => {
    const m = await mount(PENDING);
    expect(m.container.querySelector("h1")!.textContent).toBe(
      "Confirm to approve this decision",
    );
    expect(m.container.querySelector("[data-confirm-sub]")!.textContent).toBe(
      PENDING.label,
    );
    const toasts = testToasts();
    await act(async () =>
      (
        m.container.querySelector("[data-confirm-run]") as HTMLButtonElement
      ).click(),
    );
    expect(toasts.events()).toEqual([]);
    expect(ceremonies).toEqual(["get"]);
    expect(m.backend.actions).toEqual([
      {
        name: "passkeys:presenceFinish",
        args: { challenge_id: "ch-7", response: assertion },
      },
    ]);
    await m.close();
  });

  test("an enrollment challenge creates the passkey and stores it", async () => {
    const m = await mount({
      ...PENDING,
      purpose: "register",
      action: undefined,
      label: undefined,
      options: {
        challenge: "Y2g",
        rp: { id: "codecast.sh", name: "Codecast" },
        user: { id: "dQ", name: "a", displayName: "a" },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      },
    });
    expect(m.container.querySelector("h1")!.textContent).toBe(
      "Set up Touch ID",
    );
    const toasts = testToasts();
    await act(async () =>
      (
        m.container.querySelector("[data-confirm-run]") as HTMLButtonElement
      ).click(),
    );
    expect(toasts.events().filter(({ kind }) => kind === "error")).toEqual([]);
    expect(ceremonies).toEqual(["create"]);
    expect(m.backend.actions.map((a) => a.name)).toEqual([
      "passkeys:registrationFinish",
    ]);
    await m.close();
  });

  test("granted, used and expired challenges say where things stand", async () => {
    for (const [state, title] of [
      ["granted", "Confirmed"],
      ["used", "Confirmed"],
      ["expired", "This confirmation expired"],
    ] as const) {
      const m = await mount({
        purpose: "presence",
        status: state,
        action: "reveal",
        expires_at: 0,
      });
      expect(m.container.querySelector("h1")!.textContent).toBe(title);
      expect(m.container.querySelector("[data-confirm-run]")).toBeNull();
      await m.close();
    }
    const m = await mount(null);
    expect(m.container.querySelector("h1")!.textContent).toBe(
      "Nothing to confirm",
    );
    await m.close();
  });

  test("an agent's tab gets a disabled control and runs no ceremony", async () => {
    const m = await mount(PENDING, true);
    const run = m.container.querySelector(
      "[data-confirm-run]",
    ) as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    expect(run.textContent).toBe("A person confirms this");
    await act(async () =>
      window.dispatchEvent(
        new m.dom.window.KeyboardEvent("keydown", { key: "Enter" }),
      ),
    );
    expect(ceremonies).toEqual([]);
    await m.close();
  });
});
