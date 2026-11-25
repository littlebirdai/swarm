import { constants } from "node:fs";
import { access, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { cpus, loadavg, release, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ROW_COUNT, SQLITE_BUILD } from "./fixture";
import {
  BROWSERS,
  type Browser,
  type BrowserResult,
  type Report,
} from "./samples";
import { sampleWorkerHeap } from "./worker-heap";

const here = import.meta.dir;
const { values } = parseArgs({
  options: {
    chromium: { type: "string" },
    electron: { type: "string" },
    firefox: { type: "string" },
    trials: { type: "string", default: "20" },
    out: { type: "string" },
    only: { type: "string" },
  },
});
const trialCount = Number(values.trials);
if (!Number.isSafeInteger(trialCount) || trialCount < 1 || trialCount > 50)
  throw new Error("--trials must be an integer from 1 to 50");
if (values.only && !BROWSERS.some((browser) => browser === values.only))
  throw new Error("--only expects chromium, electron, safari or firefox");

async function sqliteAssets(directory: string) {
  const name = `sqlite-wasm-${SQLITE_BUILD}.tgz`;
  const response = await fetch(
    `https://registry.npmjs.org/@sqlite.org/sqlite-wasm/-/${name}`,
  );
  if (!response.ok)
    throw new Error(`SQLite download returned HTTP ${response.status}`);
  const bytes = await response.arrayBuffer();
  const integrity = new Bun.CryptoHasher("sha512")
    .update(bytes)
    .digest("base64");
  if (
    integrity !==
    "foW427VBLJ3G87bsnvQTZCc9zYe0Fq1wH0pz1I6BlKLKXcArIAyTkHtq0iT2llmhcMQt9T/p6l5PpQQh+6O8uQ=="
  )
    throw new Error("SQLite tarball failed integrity verification");
  const archive = join(directory, name);
  await Bun.write(archive, bytes);
  const unpack = Bun.spawn(["tar", "-xzf", archive, "-C", directory], {
    stderr: "inherit",
  });
  if ((await unpack.exited) !== 0)
    throw new Error("Could not extract the SQLite tarball");
  const assets = join(directory, "package", "dist");
  if (!(await Bun.file(join(assets, "index.mjs")).exists()))
    throw new Error("SQLite tarball is missing dist/index.mjs");
  return assets;
}

async function executable(paths: (string | undefined)[]) {
  for (const path of paths) {
    if (!path) continue;
    try {
      await access(path, constants.X_OK);
      return path;
    } catch {}
  }
  return undefined;
}

const apps = "/Applications";
const chromePaths = [
  Bun.which("chromium") ?? undefined,
  join(apps, "Chromium.app/Contents/MacOS/Chromium"),
  Bun.which("google-chrome") ?? undefined,
  join(apps, "Google Chrome.app/Contents/MacOS/Google Chrome"),
  join(
    apps,
    "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  ),
];
const browserPaths = {
  chromium: values.chromium ? [values.chromium] : chromePaths,
  electron: values.electron
    ? [values.electron]
    : [
        join(
          here,
          "../../../desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
        ),
        join(here, "../../../desktop/node_modules/electron/dist/electron"),
      ],
  firefox: values.firefox
    ? [values.firefox]
    : [
        Bun.which("firefox") ?? undefined,
        join(apps, "Firefox.app/Contents/MacOS/firefox"),
      ],
};

async function levelDbBytes(directory: string): Promise<number | null> {
  const entries = await readdir(directory, { withFileTypes: true });
  let total: number | null = null;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name);
    if (entry.name.endsWith(".indexeddb.leveldb")) {
      for (const file of await readdir(path, { withFileTypes: true })) {
        if (!file.isFile()) continue;
        total = (total ?? 0) + (await stat(join(path, file.name))).size;
      }
    } else {
      const bytes = await levelDbBytes(path);
      if (bytes !== null) total = (total ?? 0) + bytes;
    }
  }
  return total;
}

async function runBrowser(
  browser: Browser,
  directory: string,
  assets: string,
  bundles: string,
): Promise<BrowserResult> {
  if (values.only && browser !== values.only)
    return { status: "not-run", reason: "Excluded by --only" };
  if (browser === "safari")
    return {
      status: "not-run",
      reason:
        "Safari requires an isolated, already-authorized automation environment. The runner does not launch Safari or change Remote Automation settings.",
    };
  const binary = await executable(browserPaths[browser]);
  if (!binary)
    return { status: "not-run", reason: "No installed executable found" };
  const profile = await mkdtemp(join(directory, `${browser}-`));
  const result = Promise.withResolvers<BrowserResult>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 15,
    async fetch(request): Promise<Response> {
      const path = new URL(request.url).pathname;
      if (request.method === "POST") {
        if (path === "/worker-heap") {
          try {
            return Response.json(
              await sampleWorkerHeap(profile, url, await request.json()),
            );
          } catch (error) {
            console.error(String(error));
            return Response.json(null);
          }
        }
        if (path === "/result")
          result.resolve((await request.json()) as BrowserResult);
        if (path === "/progress")
          console.error(`${browser}: ${await request.json()}`);
        return Response.json(null);
      }
      if (path === "/" || path === "/peer") {
        return new Response(
          '<!doctype html><meta charset="utf-8"><title>Storage benchmark</title><script type="module" src="/bootstrap.js"></script>',
          {
            headers: {
              "Content-Type": "text/html",
              "Content-Security-Policy":
                "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'",
            },
          },
        );
      }
      if (path === "/bootstrap.js")
        return new Response(
          'import("/benchmark.js").catch(error => fetch("/result", {method: "POST", body: JSON.stringify({status: "error", reason: String(error)})}));',
          { headers: { "Content-Type": "text/javascript" } },
        );
      if (path === "/benchmark.js" || path === "/sqlite-worker.js")
        return new Response(Bun.file(join(bundles, path)));
      if (["/sqlite/index.mjs", "/sqlite/sqlite3.wasm"].includes(path))
        return new Response(
          Bun.file(join(assets, path.slice("/sqlite/".length))),
        );
      return new Response(null, { status: 404 });
    },
  });
  const url = `http://127.0.0.1:${server.port}/?trials=${trialCount}`;
  const chromiumFlags = [
    `--user-data-dir=${profile}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-popup-blocking",
    "--disable-renderer-backgrounding",
    "--no-first-run",
    "--no-default-browser-check",
  ];
  if (browser === "firefox")
    await Bun.write(
      join(profile, "user.js"),
      'user_pref("dom.disable_open_during_load", false);\n',
    );
  const args =
    browser === "firefox"
      ? ["-headless", "-no-remote", "-profile", profile, url]
      : browser === "electron"
        ? [...chromiumFlags, join(here, "electron-main.cjs")]
        : [...chromiumFlags, "--headless=new", url];
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([binary, ...args], {
      env: {
        ...process.env,
        STORAGE_BENCH_PROFILE: profile,
        STORAGE_BENCH_URL: url,
      },
      stdout: "ignore",
      stderr: "inherit",
    });
  } catch (error) {
    await server.stop(true);
    await rm(profile, { recursive: true, force: true });
    return {
      status: "not-run",
      reason: `Installed executable could not launch: ${(error as NodeJS.ErrnoException).code ?? String(error)}`,
    };
  }
  const timeout = setTimeout(
    () =>
      result.resolve({
        status: "error",
        reason: "Browser did not complete within 8 minutes",
      }),
    480_000,
  );
  void proc.exited.then((code) =>
    result.resolve({
      status: "error",
      reason: `Browser exited with code ${code}`,
    }),
  );
  try {
    const measured = await result.promise;
    if (measured.status === "measured" && browser !== "firefox")
      measured.dexie.databaseBytes = await levelDbBytes(profile);
    return measured;
  } finally {
    clearTimeout(timeout);
    await server.stop(true);
    if (proc.exitCode === null) proc.kill();
    await proc.exited;
    await rm(profile, { recursive: true, force: true, maxRetries: 5 });
  }
}

const directory = await mkdtemp(join(tmpdir(), "storage-benchmark-"));
try {
  const assets = await sqliteAssets(directory);
  const bundles = join(directory, "pages");
  await Bun.build({
    entrypoints: [join(here, "benchmark.ts"), join(here, "sqlite-worker.ts")],
    outdir: bundles,
    target: "browser",
    define: {
      "import.meta.env": JSON.stringify({
        DEV: false,
        VITE_CONVEX_URL: "http://127.0.0.1",
      }),
    },
    throw: true,
  });
  const load = [loadavg()];
  const browsers = {} as Report["browsers"];
  for (const browser of BROWSERS) {
    console.error(
      `${browser}: load ${loadavg()
        .map((value) => value.toFixed(2))
        .join(" ")}`,
    );
    browsers[browser] = await runBrowser(browser, directory, assets, bundles);
    load.push(loadavg());
    if (browsers[browser].status !== "measured")
      console.error(browsers[browser]);
  }
  const report: Report = {
    trialCount,
    rowCount: ROW_COUNT,
    machine: {
      cpu: cpus()[0].model,
      logicalCPUs: cpus().length,
      release: release(),
      load,
    },
    browsers,
  };
  const json = JSON.stringify(report, null, 2) + "\n";
  if (values.out) await Bun.write(values.out, json);
  else process.stdout.write(json);
} finally {
  await rm(directory, { recursive: true, force: true, maxRetries: 5 });
}
