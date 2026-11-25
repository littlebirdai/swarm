import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { walkSources, WEB_ROOT } from "./sourceWalk";

const existingDefinitions = new Set([
  "components/__tests__/composeDraftNeverLost.mount.test.tsx",
  "components/__tests__/composeModalStable.mount.test.tsx",
  "components/__tests__/composeUploadingSend.mount.test.tsx",
  "components/__tests__/composerCatch.mount.test.tsx",
  "components/__tests__/composerEscapeStops.mount.test.tsx",
  "components/__tests__/composerForkSendImages.mount.test.tsx",
  "components/__tests__/composerGateSendBatch.mount.test.tsx",
  "components/__tests__/composerSessionIdFlap.mount.test.tsx",
  "components/__tests__/composerSettledPending.mount.test.tsx",
  "components/__tests__/composerSideQuestion.mount.test.tsx",
  "components/__tests__/composerTypingBudget.mount.test.tsx",
  "components/__tests__/vaultFill.mount.test.tsx",
  "hooks/__tests__/killedShelf.test.ts",
  "hooks/__tests__/querySplitWhole.test.ts",
  "hooks/__tests__/triggerFeedHistory.test.ts",
  "lib/__tests__/remotePaneInput.test.ts",
  "lib/__tests__/walkieBursts.test.ts",
  "lib/__tests__/walkieRingAnswer.test.ts",
]);

test("web tests use the shared Convex transport for new fakes", () => {
  const definition = /\b(?:const|let|var|function)\s+fakeConvex\b/g;
  const offenders = walkSources(WEB_ROOT, { keepTests: true })
    .filter((file) => /\.test\.tsx?$/.test(file))
    .flatMap((file) => {
      const path = relative(WEB_ROOT, file);
      const count = Array.from(
        readFileSync(file, "utf8").matchAll(definition),
      ).length;
      return count > Number(existingDefinitions.has(path)) ? [path] : [];
    });
  expect(offenders).toEqual([]);
});
