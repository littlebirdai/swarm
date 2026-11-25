import { writeFileSync } from "node:fs";
import { join } from "node:path";

export function installFakeChrome(directory: string): string {
  const binary = join(directory, "fake-chrome");
  writeFileSync(
    binary,
    `#!${process.execPath}
const port = Number(process.argv.find((arg) => arg.startsWith("--remote-debugging-port=")).split("=")[1]);
Bun.serve({
  hostname: "127.0.0.1",
  port,
  routes: {
    "/json/version": Response.json({
      Browser: "Chrome/123.0.0.0",
      "Protocol-Version": "1.3",
      webSocketDebuggerUrl: \`ws://127.0.0.1:\${port}/devtools/browser/fixture\`,
    }),
  },
});
`,
    { mode: 0o755 },
  );
  return binary;
}
