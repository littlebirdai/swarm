import { describe, expect, test } from "bun:test";
import { act } from "react";
import ReactMarkdown from "react-markdown";
import { api } from "@codecast/convex/convex/_generated/api";
import { entityRemarkPlugins } from "../lib/remarkEntityIds";
import { mountWeb } from "../test-helpers/mountWeb";
import { EntityAwareCode, EntityAwareLink } from "./EntityIdPill";

const DEPLOY_RUN_ID = "44822506482";
const FAKE_DEPLOY = {
  _id: "ux72qtvpbmmrmwcjqmhzawejsx8bq9gm",
  short_id: "dp-12",
  target: "web",
  status: "running" as const,
  trigger: "person" as const,
  source: "github",
  started_by: null,
  project_id: null,
  repository: "acme/app",
  previous_sha: null,
  version: null,
  commits: [],
  note: null,
  live_at: null,
  finished_at: null,
  after: null,
  replaced_by: null,
  events: [],
  project: null,
  sha: "2a6e4120abcdef0123456789abcdef0123456789",
  url: `https://github.com/acme/app/actions/runs/${DEPLOY_RUN_ID}`,
  created_at: Date.now() - 12 * 60_000,
  carries: [],
};

const markdownWithEntities = (markdown: string) => (
  <ReactMarkdown
    remarkPlugins={entityRemarkPlugins}
    components={{ a: EntityAwareLink, code: EntityAwareCode }}
  >
    {markdown}
  </ReactMarkdown>
);

const mount = (markdown: string) =>
  mountWeb(markdownWithEntities(markdown), {
    setup: (backend) =>
      backend.set(api.deploys.get, ({ ref }) =>
        ref === DEPLOY_RUN_ID || ref === FAKE_DEPLOY.short_id
          ? FAKE_DEPLOY
          : null,
      ),
  });

describe("a GitHub Actions run named by its bare id", () => {
  test("a run that carried a deploy reads as the deploy, the word in front kept as prose", async () => {
    const { container, backend, navigationLog } = await mount(
      `Deploy ${DEPLOY_RUN_ID} is going out.`,
    );
    const html = container.querySelector("p")!.outerHTML;
    expect(html).toMatch(
      /^<p>Deploy <span class="whitespace-nowrap">|^<p>Deploy <a /,
    );
    expect(html).toContain('<span class="self-baseline">web 2a6e412</span>');
    expect(html).toContain('href="/deploys?deploy=dp-12"');
    expect(html).toContain("deploying 12m");
    expect(html).not.toContain(DEPLOY_RUN_ID);
    expect(backend.queryRequests).toContainEqual({
      name: "deploys:get",
      args: { ref: DEPLOY_RUN_ID },
    });
    await act(() =>
      container
        .querySelector<HTMLAnchorElement>('a[href="/deploys?deploy=dp-12"]')!
        .click(),
    );
    expect(navigationLog.at(-1)).toEqual({
      action: "push",
      path: "/deploys?deploy=dp-12",
    });
  });

  test("a run that carried none stays exactly the text written, with no link", async () => {
    for (const md of [
      "CI run 44822599999 passed.",
      "deploy run #44822599999 is CI.",
      "(run 44825521157)",
    ]) {
      const { container, close } = await mount(md);
      const html = container.querySelector("p")!.outerHTML;
      await close();
      expect(html).not.toContain("<a ");
      expect(html.replace(/<\/?p>/g, "")).toBe(md);
    }
  });

  test("a shorter number, or one after another word, is never a run", async () => {
    for (const md of [
      "Deploy 12345678 is a count.",
      "Order 44822506482 shipped.",
    ]) {
      const { container, close } = await mount(md);
      const html = container.querySelector("p")!.outerHTML;
      await close();
      expect(html).not.toContain("<a ");
      expect(html).toBe(`<p>${md}</p>`);
    }
  });
});
