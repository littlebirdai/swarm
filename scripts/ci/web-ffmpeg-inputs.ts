import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { parseTestCommands, ROOT } from "./test-commands";

let inputs: Set<string> | undefined;

export function webFfmpegInputs(): Set<string> {
  if (inputs) return inputs;
  const workflow = Bun.YAML.parse(
    readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8"),
  ) as {
    jobs: Record<
      string,
      {
        steps: Array<{
          name?: string;
          run: string;
          "working-directory": string;
        }>;
      }
    >;
  };
  const step = workflow.jobs["test-cli"].steps.find(
    (step) => step.name === "Web tests with ffmpeg",
  );
  if (!step) throw new Error("Missing web ffmpeg test step");
  const dir = step["working-directory"];
  const [command] = parseTestCommands(step.run, dir);
  if (command?.runner !== "bun")
    throw new Error("Expected a Bun test for web ffmpeg");
  const pending = command.args
    .filter((arg) => arg.startsWith("./"))
    .map((arg) => join(ROOT, dir, arg));
  const seen = new Set<string>();
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  while (pending.length) {
    const file = pending.pop()!;
    const path = relative(ROOT, file);
    if (seen.has(path)) continue;
    seen.add(path);
    for (const { path: spec } of transpiler.scanImports(
      readFileSync(file, "utf8"),
    )) {
      if (spec.startsWith("."))
        pending.push(Bun.resolveSync(spec, dirname(file)));
    }
  }
  inputs = seen;
  return inputs;
}
