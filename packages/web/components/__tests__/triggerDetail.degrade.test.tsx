import { expect, test } from "bun:test";
import { fixtureId, installDom, installMissingBackend, seedViewer, VIEWER_ID } from "../../test-helpers/missingBackend";

const { mountPage } = installDom("https://app.test/triggers/tr-42");
const trigger = {
  _id: fixtureId("oldertrigger"),
  short_id: "tr-42",
  user_id: VIEWER_ID,
  title: "Check the release",
  prompt: "Read the release notes.",
  schedule_type: "once",
  status: "completed",
  created_at: 1,
  run_count: 1,
};
const backend = await installMissingBackend({
  answers: {
    "agentTasks:webList": [],
    "agentTasks:webGet": trigger,
    "agentTasks:webListRuns": [],
  },
});
await seedViewer();
const { default: TriggerDetailPage } = await import("../../app/triggers/[id]/page");

test("trigger details and run history remain visible when the roster history query is missing", async () => {
  const page = await mountPage("/triggers/tr-42", { "/triggers/:id": <TriggerDetailPage /> });
  try {
    expect(backend.refused).toContain("agentTasks:webListHistory");
    expect(page.uncaught).toEqual([]);
    expect(page.text()).toContain(trigger.title);
    expect(page.text()).toContain("Run history");
    expect(page.text()).toContain("No runs yet");
  } finally {
    await page.unmount();
  }
});
