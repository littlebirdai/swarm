import { expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import { replaceGlobals } from "../../../../test-helpers/globals";
import { mountWeb } from "../../../../test-helpers/mountWeb";
import {
  ProductView,
  ProductViewPill,
  type ProductViewMint,
} from "../ProductView";
import { LIVE_PLAYERS_MAX } from "../../../ops/ReplayMomentEmbed";

const ORIGIN = "https://admin.union.example";
const CONTACT = "2b7c1d5e-9f3a-4c61-8e2d-0a1b2c3d4e5f";
let answer: (ref: string) => ProductViewMint | null;
let minted: string[] = [];
let viewer = 0;

async function mount(element: ReactElement) {
  const user = { _id: `product-view-viewer-${++viewer}` };
  const web = await mountWeb(<div data-test-view>{element}</div>, {
    path: "/line",
    setup: (backend, store) => {
      replaceGlobals({ IntersectionObserver: undefined });
      store.syncTable("currentUser", user);
      backend.action(api.sources.appViews.mint, ({ ref, workspace }) => {
        expect(workspace).toBe(`user:${user._id}`);
        minted.push(ref);
        return answer(ref);
      });
    },
  });
  return {
    ...web,
    host: web.container.querySelector<HTMLElement>("[data-test-view]")!,
    unmount: web.close,
  };
}
const ref = (id = CONTACT) => ({
  app: "union",
  view: "conversation",
  id,
  at: null,
});
const ok = (r: string): ProductViewMint => ({
  ok: true,
  app: "Union",
  view: "conversation",
  title: "Conversation",
  url: `${ORIGIN}/embed/conversation?token=t-${r.slice(-4)}`,
  origin: ORIGIN,
  expires_at: new Date(Date.now() + 600_000).toISOString(),
});

test("an app with no such view draws nothing where asked to hide, else its fallback under the head", async () => {
  answer = () => null;
  let m = await mount(<ProductView viewRef={ref()} hideWhenNone />);
  expect(m.host.innerHTML).toBe("");
  await m.unmount();
  m = await mount(
    <ProductView viewRef={ref()} fallback={<p data-ours>our text</p>} />,
  );
  expect(
    m.host.querySelector("[data-product-view]")?.getAttribute("data-state"),
  ).toBe("fallback");
  expect(m.host.querySelector("[data-ours]")?.textContent).toBe("our text");
  expect(m.host.querySelector("iframe")).toBeNull();
  await m.unmount();
});

test("a refused mint falls back and links the grant page", async () => {
  answer = () => ({
    ok: false,
    app: "Union",
    view: "conversation",
    title: "Conversation",
    error: "views.token is not granted",
    grant_url: "https://codecast.sh/ops/sources/so-3/grant",
  });
  const m = await mount(
    <ProductView viewRef={ref()} fallback={<p data-ours>our text</p>} />,
  );
  expect(m.host.querySelector("[data-ours]")).not.toBeNull();
  expect(m.host.querySelector(".pv-why a")?.getAttribute("href")).toBe(
    "https://codecast.sh/ops/sources/so-3/grant",
  );
  await m.unmount();
});

test("a connection that cannot frame the view never prints its config error to the reader (ct-58683)", async () => {
  const refused = (): ProductViewMint => ({
    ok: false,
    app: "Union",
    view: "call",
    title: "Call",
    error: "the app's url is not on fly.dev",
  });
  answer = refused;
  let m = await mount(
    <ProductView viewRef={ref()} eager fallback={<p data-ours>our text</p>} />,
  );
  expect(m.host.textContent).not.toContain("fly.dev");
  expect(m.host.querySelector(".pv-why")?.textContent).toBe(
    "can't be shown here",
  );
  expect(m.host.querySelector("[data-ours]")).not.toBeNull();
  await m.unmount();
  // Where the host already shows the finding's own words and link, a refusal draws nothing at all.
  m = await mount(<ProductView viewRef={ref()} eager hideWhenUnframed />);
  expect(m.host.innerHTML).toBe("");
  await m.unmount();
  // A pill whose view cannot open reads as the view's name, never a button that does nothing.
  m = await mount(<ProductViewPill viewRef={ref()} />);
  await act(async () => {
    (m.host.querySelector("button") as HTMLButtonElement).click();
  });
  expect(m.host.querySelector("button")).toBeNull();
  expect(m.host.querySelector("[data-failed]")?.textContent).not.toContain(
    "fly.dev",
  );
  await m.unmount();
});

test("a minted url frames the view, sized only by its own frame's tagged messages; an error falls back", async () => {
  answer = ok;
  const m = await mount(
    <ProductView viewRef={ref()} fallback={<p data-ours>our text</p>} />,
  );
  const frame = m.host.querySelector("iframe") as HTMLIFrameElement;
  expect(frame.getAttribute("src")).toStartWith(
    `${ORIGIN}/embed/conversation?token=`,
  );
  expect(frame.getAttribute("sandbox")).toContain("allow-scripts");
  expect(frame.getAttribute("sandbox")).not.toContain("allow-top-navigation");
  expect(m.host.querySelector(".pv-open")?.getAttribute("href")).toBe(
    frame.getAttribute("src"),
  );
  const post = (
    data: unknown,
    origin = ORIGIN,
    source: Window | null = frame.contentWindow,
  ) =>
    act(() => {
      window.dispatchEvent(
        new m.dom.window.MessageEvent("message", { data, origin, source }),
      );
    });
  await post(
    { source: "codecast-product-view", type: "ready", height: 400 },
    "https://evil.example",
  );
  await post(
    { source: "codecast-product-view", type: "ready", height: 400 },
    ORIGIN,
    window,
  );
  await post({ source: "someone-else", type: "ready", height: 400 });
  expect(frame.style.opacity).not.toBe("1");
  await post({ source: "codecast-product-view", type: "ready", height: 400 });
  expect(frame.style.opacity).toBe("1");
  expect(frame.style.height).toBe("400px");
  // Taller than the fold: folded, with Show all.
  await post({ source: "codecast-product-view", type: "height", height: 1400 });
  expect(frame.style.height).toBe("560px");
  const more = m.host.querySelector(".pv-more") as HTMLButtonElement;
  await act(() => more.click());
  expect(frame.style.height).toBe("1400px");
  await post({
    source: "codecast-product-view",
    type: "error",
    message: "token expired",
  });
  expect(m.host.querySelector("iframe")).toBeNull();
  expect(m.host.querySelector("[data-ours]")).not.toBeNull();
  // The reader is told it cannot be shown; the app's own reason is the title, for whoever set the connection up.
  expect(m.host.querySelector(".pv-why")?.textContent).toBe(
    "can't be shown here",
  );
  expect(m.host.querySelector(".pv-why")?.getAttribute("title")).toBe(
    "token expired",
  );
  await m.unmount();
});

test("a page opens at most a few views by itself; the rest wait for a click", async () => {
  answer = ok;
  minted.length = 0;
  const n = LIVE_PLAYERS_MAX + 1;
  const ids = Array.from(
    { length: n },
    (_, i) => `${CONTACT.slice(0, -1)}${i}`,
  );
  const m = await mount(
    <div>
      {ids.map((id) => (
        <ProductView key={id} viewRef={ref(id)} />
      ))}
    </div>,
  );
  expect(minted.length).toBe(LIVE_PLAYERS_MAX);
  expect(m.host.querySelectorAll("iframe").length).toBe(LIVE_PLAYERS_MAX);
  const waiting = m.host.querySelectorAll(".pv-play");
  expect(waiting.length).toBe(1);
  await act(async () => {
    (waiting[0] as HTMLButtonElement).click();
  });
  expect(minted.length).toBe(n);
  expect(m.host.querySelectorAll("iframe").length).toBe(n);
  await m.unmount();
});

test("a minted url on codecast's own site is never framed: it falls back and says why", async () => {
  // The page is local.codecast.sh; a published page under codecast.sh is the same site, and its frame would be this page's origin's peer.
  answer = () => ({
    ok: true,
    app: "Union",
    view: "conversation",
    title: "Conversation",
    url: "https://embed.app.test/a/slug?token=t",
    origin: "https://embed.app.test",
    expires_at: new Date(Date.now() + 600_000).toISOString(),
  });
  const m = await mount(
    <ProductView
      viewRef={ref("0a0a0a0a-0000-4000-8000-000000000001")}
      fallback={<p data-ours>our text</p>}
    />,
  );
  expect(m.host.querySelector("iframe")).toBeNull();
  expect(m.host.querySelector("[data-ours]")).not.toBeNull();
  expect(m.host.querySelector(".pv-why")?.getAttribute("title")).toContain(
    "codecast's own site",
  );
  await m.unmount();
});

test("a fallback that names the thing shows at once, before the view is near or minted, and when no app has the view (ct-58683)", async () => {
  answer = () => null;
  const call = { app: "union", view: "call", id: CONTACT, at: null };
  const m = await mount(
    <ProductView
      viewRef={call}
      hideWhenNone
      fallbackNames
      fallback={<p data-ours>Eric called Carmit</p>}
    />,
  );
  expect(m.host.querySelector("[data-ours]")?.textContent).toBe(
    "Eric called Carmit",
  );
  expect(m.host.querySelector(".pv-head")).toBeNull();
  await m.unmount();
});
