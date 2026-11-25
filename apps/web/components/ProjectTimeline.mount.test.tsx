import { api } from "@codecast/convex/convex/_generated/api";
import { expect, test } from "bun:test";
import type { FunctionReturnType } from "convex/server";
import type { ProjectUpdateRow } from "../store/projectUpdatesSlice";
import { expectAbsent, expectPresent } from "../test-helpers/domExpect";
import { mountWeb } from "../test-helpers/mountWeb";
import { waitForDom } from "../test-helpers/waitForDom";
import { ProjectTimeline } from "./ProjectTimeline";

test("a held post's comments ride its card, and an unheld post's comment stays on the rail", async () => {
  const now = Date.now();
  const post: ProjectUpdateRow = {
    _id: "upd_held",
    project_id: "proj",
    title: "Week 1",
    body: "Shipped",
    kind: "update",
    author: "Ashot",
    author_kind: "user",
    created_at: now - 60_000,
    comments: [
      {
        _id: "comment-held",
        author: "Sam",
        author_kind: "user",
        text: "Nice work",
        created_at: now - 30_000,
      },
    ],
  };
  const events: NonNullable<
    FunctionReturnType<typeof api.projectUpdates.webTimeline>
  > = [
    {
      ts: now - 60_000,
      type: "update_posted",
      actor: "Ashot",
      update: {
        id: "upd_held",
        title: "Week 1",
        kind: "update",
        body: "Shipped",
      },
    },
    {
      ts: now - 30_000,
      type: "update_comment",
      actor: "Sam",
      text: "Nice work",
      update: { id: "upd_held", title: "Week 1", kind: "update", body: "" },
    },
    {
      ts: now - 20_000,
      type: "update_comment",
      actor: "Sam",
      text: "And this one",
      update: {
        id: "upd_elsewhere",
        title: "Week 0",
        kind: "update",
        body: "",
      },
    },
  ];

  const web = await mountWeb(
    <ProjectTimeline projectId="proj" composer={false} />,
    {
      setup(backend, store) {
        store.syncTable("projectUpdates", [
          post,
          {
            ...post,
            _id: "other-project-post",
            project_id: "other",
            title: "Other project",
          },
        ]);
        backend.set(api.projectUpdates.webTimeline, ({ project_id }) =>
          project_id === "proj" ? events : [],
        );
      },
    },
  );

  const card = web.container.querySelector('[data-project-update="upd_held"]');
  expectPresent(card);
  expect(card.textContent).toContain("Week 1");
  expectAbsent(
    web.container.querySelector('[data-project-update="other-project-post"]'),
  );
  expectAbsent(web.container.querySelector("[data-project-update-open]"));
  await waitForDom(web.container, () =>
    /Sam commented on.*Week 0.*And this one/.test(
      web.container.textContent ?? "",
    ),
  );
  expect(web.container.textContent?.match(/Week 1/g)).toHaveLength(1);
  expect(card.textContent).toContain("Nice work");
  expect(web.container.textContent?.match(/Nice work/g)).toHaveLength(1);
  expect(web.backend.queryRequests).toContainEqual({
    name: "projectUpdates:webTimeline",
    args: { project_id: "proj" },
  });
});
