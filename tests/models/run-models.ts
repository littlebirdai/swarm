import { mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import expectations from "./expectations.json";
import { parseTlcResult } from "./tlc-result";

const version = "1.7.4";
const sha256 =
  "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88";
const modelDir = import.meta.dir;

type Expected = {
  violations: string[];
  distinctStates?: number;
  stopAfterCounterexamples?: boolean;
};

async function tlcJar() {
  const cache = join(
    process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
    "swarm",
    "tlc",
  );
  const path = join(cache, `tla2tools-${version}.jar`);
  const file = Bun.file(path);

  try {
    if (await file.exists()) {
      const digest = Bun.CryptoHasher.hash("sha256", await file.bytes(), "hex");
      if (digest !== sha256) {
        throw new Error(`SHA-256 mismatch. Remove ${path} and retry.`);
      }
      return path;
    }

    const response = await fetch(
      `https://github.com/tlaplus/tlaplus/releases/download/v${version}/tla2tools.jar`,
      { signal: AbortSignal.timeout(30_000) },
    );
    if (!response.ok)
      throw new Error(`Download returned HTTP ${response.status}.`);
    const bytes = await response.bytes();
    if (Bun.CryptoHasher.hash("sha256", bytes, "hex") !== sha256) {
      throw new Error("SHA-256 mismatch for the download.");
    }
    await mkdir(cache, { recursive: true });
    const download = await mkdtemp(join(cache, "download-"));
    try {
      const temporary = join(download, "tla2tools.jar");
      await Bun.write(temporary, bytes);
      await rename(temporary, path);
    } finally {
      await rm(download, { recursive: true, force: true });
    }
    return path;
  } catch (error) {
    throw new Error(`Cannot use TLC ${version}: ${error}`);
  }
}

async function check(
  java: string,
  jar: string,
  model: string,
  configName: string,
  expected: Expected,
) {
  const dir = await mkdtemp(join(tmpdir(), "swarm-tlc-"));
  const configPath = join(dir, configName);
  try {
    let config = await Bun.file(join(modelDir, configName)).text();
    let seen = 0;
    while (true) {
      await Bun.write(configPath, config);
      const tlc = Bun.spawn(
        [
          java,
          "-Xmx512m",
          "-XX:+UseParallelGC",
          "-cp",
          jar,
          "tlc2.TLC",
          "-workers",
          "1",
          "-seed",
          "1",
          "-fp",
          "0",
          "-metadir",
          dir,
          "-config",
          configPath,
          model,
        ],
        { cwd: modelDir, stdout: "pipe", stderr: "pipe", timeout: 120_000 },
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        tlc.exited,
        new Response(tlc.stdout).text(),
        new Response(tlc.stderr).text(),
      ]);
      const result = parseTlcResult(exitCode, stdout + stderr, config);
      const nextRule = expected.violations[seen];
      const actualRule =
        result.outcome === "violated" ? result.rule : undefined;
      if (actualRule !== nextRule) {
        throw new Error(
          `Expected ${nextRule ?? "holds"}, got ${actualRule ?? "holds"}.\n${stdout}`,
        );
      }
      if (result.outcome === "violated") seen++;
      if (
        result.outcome === "holds" ||
        (seen === expected.violations.length &&
          (expected.stopAfterCounterexamples || result.kind === "property"))
      ) {
        if (
          expected.distinctStates !== undefined &&
          expected.distinctStates !== result.distinctStates
        ) {
          throw new Error(
            `Expected ${expected.distinctStates} distinct states, got ${result.distinctStates}.`,
          );
        }
        const rules = expected.violations.join(", ") || "holds";
        console.log(
          `${configName}: ${rules} (${result.distinctStates} distinct states)`,
        );
        return;
      }

      const declaration = `INVARIANT ${actualRule}\n`;
      if (!config.includes(declaration)) {
        throw new Error(
          `Cannot remove checked invariant ${actualRule} from ${configName}.`,
        );
      }
      config = config.replace(declaration, "");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const entries: Record<string, Record<string, Expected>> = expectations;
const files = await readdir(modelDir);
const registered = Object.entries(entries).flatMap(([model, configs]) => [
  `${model}.tla`,
  ...Object.keys(configs).map((name) => `${name}.cfg`),
]);
const checkedFiles = files.filter((name) => /\.(cfg|tla)$/.test(name)).sort();
if (JSON.stringify(registered.sort()) !== JSON.stringify(checkedFiles)) {
  throw new Error(
    "Each TLA+ module and config must appear once in expectations.json.",
  );
}

const java = Bun.which(
  process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", "java") : "java",
);
if (
  !java ||
  (await Bun.spawn([java, "-version"], { stderr: "ignore" }).exited) !== 0
) {
  throw new Error(
    "Java is required for TLC. Set JAVA_HOME or put java on PATH.",
  );
}
const jar = await tlcJar();
let failed = false;
for (const [model, configs] of Object.entries(entries)) {
  for (const [name, expected] of Object.entries(configs)) {
    try {
      await check(java, jar, model, `${name}.cfg`, expected);
    } catch (error) {
      console.error(`${name}.cfg: ${error}`);
      failed = true;
    }
  }
}
if (failed) process.exitCode = 1;
