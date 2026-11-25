import { describe, expect, test } from "bun:test";
import { act } from "react";
import { mountWeb } from "../../test-helpers/mountWeb";
import type { PrDeployModel } from "../../hooks/usePrDeploy";
import { PRDeployBand, PRShipsTo } from "./PRDeploy";

const NOW = 1_800_000_000_000;
const base = {
  teamId: "T1",
  repository: "acme/app",
  number: 101,
  now: NOW,
  mergedAt: NOW - 3_600_000,
  press: { open() {}, review: null },
  headline: null,
};
const linksIn = (container: HTMLElement) => [
  ...container.querySelectorAll<HTMLAnchorElement>('a[href*="/deploys"]'),
];

describe("the PR page's links into Deploys", async () => {
  test("a merged PR's band opens each target with the PR highlighted", async () => {
    const model: PrDeployModel = {
      ...base,
      merged: true,
      open: false,
      shipsTo: null,
      declares: true,
      rows: [
        {
          target: "web",
          state: "live",
          deploy: {
            short_id: "dp-12",
            status: "live",
            sha: "2a6e412abc",
            at: NOW - 60_000,
            url: null,
          },
          now: null,
          note: null,
          queue: null,
          press: null,
          pressWords: null,
          blocked: null,
        },
      ],
      dormant: [{ target: "cli", at: null }],
    };
    const { container, navigationLog } = await mountWeb(
      <PRDeployBand model={model} />,
    );
    const links = linksIn(container);
    const addresses = links.map((link) => link.getAttribute("href"));
    expect(addresses).toEqual([
      "/deploys?team=T1&repo=acme%2Fapp&target=web&pr=101",
      "/deploys?deploy=dp-12",
      "/deploys?team=T1&repo=acme%2Fapp&target=web&pr=101",
      "/deploys?team=T1&repo=acme%2Fapp&target=cli&pr=101",
    ]);
    await act(() => links[0]!.click());
    expect(navigationLog.at(-1)).toEqual({
      action: "push",
      path: links[0]!.getAttribute("href")!,
    });
  });

  test("an open PR's targets open on the Deploys page with nothing highlighted", async () => {
    const model: PrDeployModel = {
      ...base,
      merged: false,
      open: true,
      declares: true,
      rows: [],
      dormant: [],
      shipsTo: [
        {
          target: {
            _id: "deploy-target-web",
            workspace: "team:T1",
            team_id: "T1",
            name: "web",
            repository: base.repository,
            runs: "here",
            policy: "auto",
            command: null,
            rollback: null,
            paths: [],
            can_deploy: false,
            can_redeploy_sha: false,
            can_rollback: false,
            device_id: null,
            publisher_user_id: "publisher",
            queue: {
              known: true,
              truncated: false,
              commits: 0,
              untouched: 0,
              head_sha: null,
              head_ci: "none",
              head_ci_url: null,
              shown: 0,
              groups: [],
            },
          },
          idle: false,
        },
      ],
    };
    const { container } = await mountWeb(<PRShipsTo model={model} />);
    expect(linksIn(container).map((link) => link.getAttribute("href"))).toEqual(
      ["/deploys?team=T1&repo=acme%2Fapp&target=web"],
    );
  });
});
