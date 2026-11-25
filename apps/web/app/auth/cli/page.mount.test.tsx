import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { afterEach, expect, spyOn, test } from "bun:test";
import { useConvex } from "convex/react";
import { act } from "react";
import { Route, Routes } from "react-router";
import { cliJustConnected } from "../../../lib/cliConnected";
import {
  AUTH_JWT_STORAGE_KEY,
  AUTH_REFRESH_TOKEN_STORAGE_KEY,
  CONVEX_URL,
} from "../../../lib/localAuth";
import { webBuilders } from "../../../test-helpers/builders";
import { expectAbsent, expectPresent } from "../../../test-helpers/domExpect";
import { mountWeb } from "../../../test-helpers/mountWeb";
import Login from "../../login/page";
import CliAuth from "./page";

const path = "/auth/cli?nonce=n1&port=4242";
const { teamMember } = webBuilders("auth/cli/page.mount.test.tsx");
const viewer = {
  ...teamMember.build({ email: "new@example.test" }),
  _creationTime: 1,
};
const token = "test-terminal-token";
const authorizeButton = () =>
  Array.from(document.querySelectorAll("button")).find(
    (button) => button.textContent === "Authorize",
  ) ?? null;

function AuthRoutes({ confirmed }: { confirmed: boolean }) {
  const client = useConvex();
  return (
    <ConvexAuthProvider
      client={client}
      storageNamespace={CONVEX_URL}
      storage={confirmed ? localStorage : sessionStorage}
    >
      <Routes>
        <Route path="/auth/cli" element={<CliAuth />} />
        <Route path="/login" element={<Login />} />
        <Route path="/inbox" element={<h1>Inbox</h1>} />
      </Routes>
    </ConvexAuthProvider>
  );
}

function registeredRequest() {
  const now = Date.now();
  return {
    device_name: "build-box",
    ip: "198.51.100.7",
    country: "NL",
    created_at: now - 30_000,
    expires_at: now + 300_000,
    used: false,
  };
}

let restoreFetch: (() => void) | undefined;
const deliveries: Array<{ address: string; method?: string; body: unknown }> =
  [];
afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
  deliveries.length = 0;
});

function mount(
  confirmed: boolean,
  request = null as ReturnType<typeof registeredRequest> | null,
) {
  return mountWeb(<AuthRoutes confirmed={confirmed} />, {
    path,
    setup(backend) {
      const now = Math.floor(Date.now() / 1000);
      const claims = Buffer.from(
        JSON.stringify({ iat: now, exp: now + 3600 }),
      ).toString("base64url");
      const jwt = "eyJhbGciOiJIUzI1NiJ9." + claims + ".test";
      const refreshToken = "test-refresh-token";
      localStorage.setItem(AUTH_JWT_STORAGE_KEY, jwt);
      localStorage.setItem(AUTH_REFRESH_TOKEN_STORAGE_KEY, refreshToken);
      const reply = async (...[address, options]: Parameters<typeof fetch>) => {
        const url = new URL(String(address));
        if (
          url.origin === "https://mount-test.convex.cloud" &&
          url.pathname === "/api/action"
        ) {
          expect(JSON.parse(String(options?.body))).toMatchObject({
            path: "auth:signIn",
            args: [{ refreshToken }],
          });
          return Response.json({
            status: "success",
            value: { tokens: { token: jwt, refreshToken } },
          });
        }
        deliveries.push({
          address: url.href,
          method: options?.method,
          body: options?.body,
        });
        return Response.json({});
      };
      const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(reply, { preconnect: fetch.preconnect }),
      );
      restoreFetch = () => fetchSpy.mockRestore();
      backend.set(api.auth.signInProviders, { google: false });
      backend.set(api.users.getCurrentUser, viewer);
      backend.set(api.cliAuth.requestInfo, ({ nonce }) =>
        nonce === "n1" ? request : null,
      );
      backend.mutation(api.apiTokens.createToken, {
        token,
        userId: viewer._id,
      });
    },
  });
}

test("an unconfirmed stored token waits on /auth/cli instead of bouncing through /login", async () => {
  const web = await mount(false);
  expect(web.navigationLog).toEqual([{ path, action: "pop" }]);
  expectAbsent(authorizeButton());
  expect(web.backend.mutations).toEqual([]);
});

test("a cleared token leaves for /login once and stays there", async () => {
  const web = await mount(false);
  expect(web.navigationLog).toEqual([{ path, action: "pop" }]);
  localStorage.removeItem(AUTH_JWT_STORAGE_KEY);
  await web.rerender(<AuthRoutes confirmed={false} />);
  expect(web.navigationLog.slice(1)).toEqual([
    { path: "/login?return_to=" + encodeURIComponent(path), action: "push" },
  ]);
  expect(web.container.textContent).toContain("Sign in");
});

test("authorizing hands the tab to the inbox, stamped as just connected", async () => {
  const web = await mount(true);
  const authorize = authorizeButton();
  expectPresent(authorize);
  expect(web.container.textContent).toContain("new@example.test");
  const setTimer = globalThis.setTimeout;
  const redirects: Array<() => void> = [];
  const schedule = spyOn(globalThis, "setTimeout").mockImplementation(((
    fn: () => void,
    ms?: number,
  ) => {
    if (ms !== 1500) return setTimer(fn, ms);
    redirects.push(fn);
    return setTimer(() => {}, ms);
  }) as typeof setTimeout);
  try {
    await act(async () => authorize.click());
    expect(redirects).toHaveLength(1);
    await act(async () => redirects[0]());
    expect(web.backend.mutations).toEqual([
      { name: "apiTokens:createToken", args: { name: "CLI Device" } },
    ]);
    expect(deliveries).toEqual([
      {
        address: "http://127.0.0.1:4242/callback",
        method: "POST",
        body: JSON.stringify({
          userId: viewer._id,
          apiToken: token,
          nonce: "n1",
        }),
      },
    ]);
    expect(web.navigationLog.slice(1)).toEqual([
      { path: "/inbox", action: "replace" },
    ]);
    expect(cliJustConnected()).toBe(true);
  } finally {
    schedule.mockRestore();
  }
});

test("a registered request shows the network it came from, and a used one cannot be authorized", async () => {
  const request = registeredRequest();
  const web = await mount(true, request);
  expect(web.container.textContent).toContain(request.ip);
  expect(web.container.textContent).toContain(request.device_name);
  expectPresent(authorizeButton());

  await act(async () => {
    web.backend.set(api.cliAuth.requestInfo, ({ nonce }) =>
      nonce === "n1" ? { ...request, used: true } : null,
    );
  });
  expectAbsent(authorizeButton());
  expect(web.container.textContent).toContain("Already used");
  await act(async () => {
    web.container
      .querySelectorAll("button")
      .forEach((button) => button.click());
  });
  expect(web.backend.mutations).toEqual([]);
});
