import { readConfig } from "../src/config";
import { startRelayServer } from "../src/server";

const relay = startRelayServer(readConfig(process.env));
try {
  process.send?.(relay.url.href);
  await Bun.stdin.text();
} finally {
  await relay.stop();
}
