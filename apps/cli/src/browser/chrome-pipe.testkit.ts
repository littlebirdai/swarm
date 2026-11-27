import { spawn } from "../proc.js";
import type { Readable, Writable } from "node:stream";
import { CdpConnection } from "./cdp.js";

export async function connectTestChrome(
  binary: string,
  profile: string,
): Promise<{ conn: CdpConnection; stop: () => Promise<void> }> {
  const proc = spawn(
    binary,
    [
      "--headless=new",
      "--remote-debugging-pipe",
      `--user-data-dir=${profile}`,
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-sync",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--use-mock-keychain",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] },
  );
  const diagnostics = proc.stderr as Readable;
  const requests = proc.stdio[3] as Writable;
  const responses = proc.stdio[4] as Readable;
  const exited = Promise.withResolvers<never>();
  const closed = Promise.withResolvers<void>();
  let stderr = "";
  diagnostics.setEncoding("utf8").on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-4096);
  });
  proc.once("error", (error) => {
    exited.reject(error);
    closed.resolve();
  });
  proc.once("exit", (code, signal) => {
    exited.reject(new Error(`Chrome exited (${signal ?? code}): ${stderr}`));
    closed.resolve();
  });
  requests.on("error", exited.reject);
  responses.on("error", exited.reject);
  exited.promise.catch(() => {});

  const channel = "cdp";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, relay) {
      if (relay.upgrade(request)) return;
      return new Response(null, { status: 426 });
    },
    websocket: {
      open(socket) {
        socket.subscribe(channel);
      },
      message(_socket, message) {
        requests.write(String(message) + "\0");
      },
    },
  });
  let buffered = "";
  responses.setEncoding("utf8").on("data", (chunk: string) => {
    buffered += chunk;
    let end: number;
    while ((end = buffered.indexOf("\0")) !== -1) {
      server.publish(channel, buffered.slice(0, end));
      buffered = buffered.slice(end + 1);
    }
  });

  let conn: CdpConnection | undefined;
  const stop = async () => {
    conn?.close();
    proc.kill("SIGKILL");
    requests.destroy();
    responses.destroy();
    diagnostics.destroy();
    await closed.promise;
    await server.stop(true);
  };
  try {
    conn = await Promise.race([
      CdpConnection.connect(`ws://127.0.0.1:${server.port}`),
      exited.promise,
    ]);
    await Promise.race([
      conn.send("Browser.getVersion", {}, undefined, 20_000),
      exited.promise,
    ]);
    return { conn, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
