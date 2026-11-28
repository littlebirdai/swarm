import { expect, test } from "bun:test";

test("the daemon starts its worker hosts at boot with no setting", async () => {
  const daemon = await Bun.file(
    new URL("../daemon.ts", import.meta.url),
  ).text();
  const boot = daemon.indexOf("await waitForConfig();");
  const start = daemon.indexOf("void configureDaemonWorkers().catch(");
  expect(boot).toBeGreaterThan(0);
  expect(start).toBeGreaterThan(boot);
  expect(daemon.split("configureDaemonWorkers(")).toHaveLength(2);
});
