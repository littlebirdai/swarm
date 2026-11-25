import { act } from "react";
import { expect, test } from "bun:test";
import { mountWeb } from "../../../../test-helpers/mountWeb";
import { MainDetails } from "../PipelineDrawer";
import { PIPELINE_FIXTURES } from "../../../../lib/line/__tests__/pipelines.fixture.generated";
import {
  pipelineModel,
  type PipelineModel,
} from "../../../../lib/line/pipelineModel";

const example = PIPELINE_FIXTURES.find(
  (p) => p.repository === "example-org/example-app",
)!;

test("each target opens on Deploys, a going or failed one at its deploy", async () => {
  const m = pipelineModel(example);
  const quiet = {
    policy: "auto",
    runs: "here",
    waiting: 0,
    groups: [] as PipelineModel["main"]["targets"][number]["groups"],
    live: null,
    going: null,
    failed: null,
  } as const;
  const model: PipelineModel = {
    ...m,
    main: {
      waiting: 0,
      targets: [
        {
          ...quiet,
          name: "web",
          tone: "going",
          going: { deploy: "dp-7", step: null, outside: false, stuck: null },
        },
        {
          ...quiet,
          name: "cli",
          tone: "failed",
          failed: { deploy: "dp-5", at: 1, step: null },
        },
        { ...quiet, name: "docs", tone: "current" },
      ],
    },
  };
  const { container, navigationLog } = await mountWeb(
    <MainDetails model={model} teamId="T1" />,
  );
  const targets = [
    ...container.querySelectorAll<HTMLAnchorElement>('a[href^="/deploys"]'),
  ];
  const links = targets.map((target) => target.getAttribute("href"));
  expect(links).toEqual([
    "/deploys?team=T1&repo=example-org%2Fexample-app&target=web&deploy=dp-7",
    "/deploys?team=T1&repo=example-org%2Fexample-app&target=cli&deploy=dp-5",
    "/deploys?team=T1&repo=example-org%2Fexample-app&target=docs",
  ]);
  await act(() => targets[0]!.click());
  expect(navigationLog.at(-1)).toEqual({
    action: "push",
    path: targets[0]!.getAttribute("href")!,
  });
});
