import { afterEach, beforeEach, expect, test } from "bun:test";
import { makeFunctionReference } from "convex/server";
import { act } from "react";
import { applyPullRequestAnswer } from "../../hooks/useSyncTimeline";
import { isFullPullRequest } from "../../lib/cardPullRequestRows";
import { DETAIL_ROW_CAPS, isDetailPinned } from "../../lib/detail-rows";
import { collectionRowHydrator } from "../../store/clientSyncRegistry";
import { useInboxStore } from "../../store/inboxStore";
import { flushSyncPublishes } from "../../store/syncTransaction";
import { mountWeb } from "../../test-helpers/mountWeb";
import { EntityObjectCard } from "../EntityObjectCard";
import { PRCard } from "../PRCard";
import { PullRequestHoverContent } from "../RepoObjectHoverContent";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";

const flag = "VITE_THIN_PULL_REQUEST_ROWS";
const originalFlag = process.env[flag];
const webGet = makeFunctionReference<"query">("pull_requests:webGet");
const cap = DETAIL_ROW_CAPS.pullRequestDetails;
const row = (number: number) => ({
  _id: `j${String(number).padStart(31, "0")}` as Id<"pull_requests">,
  repository: "acme/app",
  number,
  title: `Pull request ${number}`,
  body: `The complete description for ${number}`,
  state: "open" as const,
  author_github_username: "fixture",
  created_at: 1,
  updated_at: 1,
});
const getState = useInboxStore.getState;

beforeEach(() => {
  process.env[flag] = "1";
});

afterEach(() => {
  if (originalFlag === undefined) delete process.env[flag];
  else process.env[flag] = originalFlag;
  useInboxStore.setState({ pullRequests: {}, pullRequestDetails: {} });
});

test("PR bodies stay out of list pushes, single-row writes and cached list reads", () => {
  const listed = row(1);
  const single = row(2);
  getState().syncTable("pullRequests", [listed]);
  getState().syncRecord("pullRequests", single._id, single);
  const fromDisk = collectionRowHydrator("pullRequests")?.(listed, {
    pending: {},
  });
  for (const thin of [
    getState().pullRequests[listed._id],
    getState().pullRequests[single._id],
    fromDisk,
  ]) {
    expect(thin).toBeDefined();
    expect(thin).not.toHaveProperty("body");
    expect(isFullPullRequest(thin!)).toBe(true);
  }
  expect(getState().pullRequestDetails).toEqual({});
});

test.each([false, true])(
  "an expanded PR card shows the body from its pinned detail row (files supplied: %s)",
  async (withFiles) => {
    const files = withFiles
      ? [
          {
            filename: "README.md",
            status: "modified",
            additions: 1,
            deletions: 0,
            changes: 1,
          },
        ]
      : undefined;
    const pr = row(1);
    const { body: _body, ...props } = pr;
    const ui = await mountWeb(<PRCard {...props} files={files} />, {
      setup(backend, store) {
        store.syncTable("pullRequests", [pr]);
        backend.set(webGet, pr);
      },
    });
    try {
      expect(ui.container.textContent).not.toContain(pr.body);
      expect(ui.backend.queryRequests).toEqual([]);
      const title = [...ui.container.querySelectorAll("span")].find(
        (node) => node.textContent === pr.title,
      );
      expect(title).toBeDefined();
      await act(async () => title!.click());
      await act(async () => flushSyncPublishes());
      expect(ui.backend.queryRequests).toContainEqual({
        name: "pull_requests:webGet",
        args: { id: pr._id },
      });
      expect(ui.container.textContent).toContain(pr.body);
      if (withFiles) expect(ui.container.textContent).toContain("README.md");
      expect(getState().pullRequests[pr._id]).not.toHaveProperty("body");

      await act(async () => {
        for (let number = 2; number <= cap + 1; number++)
          applyPullRequestAnswer(row(number));
        flushSyncPublishes();
      });
      expect(getState().pullRequestDetails[pr._id]?.body).toBe(pr.body);
      expect(ui.container.textContent).toContain(pr.body);
      expect(Object.keys(getState().pullRequestDetails)).toHaveLength(cap);
    } finally {
      await ui.close();
    }
  },
);

test("an opened PR hover shows the body from its detail feeder", async () => {
  const pr = row(1);
  const { body: _body, ...props } = pr;
  const ui = await mountWeb(
    <PullRequestHoverContent
      pr={props}
      href="/pr/acme/app/1"
      onOpen={() => {}}
      production={null}
      showOpen={false}
    />,
    { setup: (backend) => backend.set(webGet, pr) },
  );
  try {
    await act(async () => flushSyncPublishes());
    expect(ui.container.textContent).toContain(pr.body);
    expect(getState().pullRequestDetails[pr._id]?.body).toBe(pr.body);
  } finally {
    await ui.close();
  }
});

test("the detail cap evicts an unpinned PR body", () => {
  const first = row(1);
  applyPullRequestAnswer(first);
  expect(getState().pullRequestDetails[first._id]?.body).toBe(first.body);
  for (let number = 2; number <= cap + 1; number++)
    applyPullRequestAnswer(row(number));
  expect(Object.keys(getState().pullRequestDetails)).toHaveLength(cap);
  expect(getState().pullRequestDetails[first._id]).toBeUndefined();
});

test("15 collapsed shared PR cards use only their list feeds and pin no details", async () => {
  const prs = Array.from({ length: 15 }, (_, index) => ({
    ...row(index + 1),
    files: [
      {
        filename: "README.md",
        status: "modified",
        additions: 1,
        deletions: 0,
        changes: 1,
        patch: "x".repeat(175_000),
      },
    ],
    commits: [],
    checks: [],
  }));
  const ui = await mountWeb(
    <>
      {prs.map((pr) => (
        <EntityObjectCard
          key={pr._id}
          refId={`${pr.repository}#${pr.number}`}
          count={1}
        />
      ))}
    </>,
    {
      setup(backend, store) {
        store.syncTable("pullRequests", prs);
        backend.set(
          webGet,
          ({ id, number }) =>
            prs.find((pr) => pr._id === id || pr.number === number) ?? null,
        );
      },
    },
  );
  const subscriptions = () =>
    ui.backend.queryRequests.filter(
      (request) => request.name === "pull_requests:webGet",
    );
  const pins = () =>
    prs.filter((pr) => isDetailPinned("pullRequestDetails", pr._id));
  try {
    await act(async () => flushSyncPublishes());
    expect(
      ui.container.querySelectorAll('.entity-card[aria-expanded="false"]'),
    ).toHaveLength(15);
    expect({
      subscriptions: subscriptions().length,
      pins: pins().length,
      detailRows: Object.keys(getState().pullRequestDetails).length,
    }).toEqual({ subscriptions: 15, pins: 0, detailRows: 0 });
    expect(getState().pullRequests[prs[0]._id]).not.toHaveProperty("body");

    const card = ui.container.querySelector<HTMLElement>(".entity-card")!;
    const first = prs[0];
    await act(async () => card.click());
    await act(async () => flushSyncPublishes());
    expect(card.getAttribute("aria-expanded")).toBe("true");
    expect(card.querySelector(".entity-card-expand")?.textContent).toContain(
      first.body,
    );
    expect(subscriptions()).toHaveLength(16);
    expect(pins()).toEqual([first]);
    expect(Object.keys(getState().pullRequestDetails)).toEqual([first._id]);
  } finally {
    await ui.close();
  }
});

test("flag-off hydration clears the full-projection marker from bodyless PR rows", () => {
  const hydrate = collectionRowHydrator("pullRequests")!;
  const context = { pending: {} };
  const pr = row(1);
  const cached = hydrate(pr, context);
  expect(isFullPullRequest(cached)).toBe(true);
  expect(cached).not.toHaveProperty("body");

  process.env[flag] = "0";
  const restored = hydrate(cached, context);
  expect(restored).not.toHaveProperty("has_full_projection");
  expect(isFullPullRequest(restored)).toBe(false);
  expect(isFullPullRequest(hydrate({ ...pr, body: "" }, context))).toBe(true);
});

test("a flag-off refresh and cache hydration discard previously split bodies", () => {
  const pr = { ...row(1), files: [] };
  applyPullRequestAnswer(pr);
  const held = getState().pullRequestDetails[pr._id];
  expect(held?.body).toBe(pr.body);

  process.env[flag] = "0";
  const hydrate = collectionRowHydrator("pullRequestDetails");
  const fromDisk = hydrate?.(held, { pending: {} });
  expect(fromDisk).not.toHaveProperty("body");
  expect(fromDisk?.files).toEqual(pr.files);
  applyPullRequestAnswer(pr);
  expect(getState().pullRequestDetails[pr._id]).not.toHaveProperty("body");
  expect(getState().pullRequestDetails[pr._id]?.files).toEqual(pr.files);
  expect(getState().pullRequests[pr._id]?.body).toBe(pr.body);
});
