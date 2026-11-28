import { parseArgs } from "node:util";
import { type PopulationMode, runPopulation } from "./run";

const { values } = parseArgs({
  options: {
    people: { type: "string", default: "10" },
    devices: { type: "string" },
    seed: { type: "string", default: "42" },
    mode: { type: "string", default: "team" },
    realistic: { type: "boolean" },
    compare: { type: "boolean" },
    json: { type: "boolean" },
  },
});
const people = Number(values.people);
const devices =
  values.devices === undefined ? Math.min(people, 20) : Number(values.devices);
const seed = Number(values.seed);
const comparePoints = [
  { people: 1, devices: 1 },
  { people: 50, devices: 50 },
  { people: 500, devices: 20 },
];
if (!values.compare) {
  if (!Number.isInteger(people) || people < 1 || people > 500)
    throw new Error("--people must be an integer from 1 to 500");
  if (
    !Number.isInteger(devices) ||
    devices < 1 ||
    devices > Math.min(people, 50)
  )
    throw new Error(
      "--devices must be an integer from 1 to the smaller of 50 and --people",
    );
}
if (!Number.isSafeInteger(seed)) throw new Error("--seed must be an integer");
if (
  values.mode !== "team" &&
  values.mode !== "interest" &&
  values.mode !== "both"
)
  throw new Error("--mode must be team, interest, or both");

const realistic = !!values.compare || !!values.realistic;
const runs: { people: number; devices: number; mode: PopulationMode }[] =
  values.compare
    ? (["team", "interest"] as const).flatMap((mode) =>
        comparePoints.map((point) => ({ ...point, mode })),
      )
    : values.mode === "both"
      ? (["team", "interest"] as const).map((mode) => ({
          people,
          devices,
          mode,
        }))
      : [{ people, devices, mode: values.mode }];

const results = [];
for (const entry of runs) {
  results.push(await runPopulation({ ...entry, seed, realistic }));
}

if (values.json) {
  console.log(
    JSON.stringify(results.length === 1 ? results[0] : results, null, 2),
  );
} else {
  console.table(
    results.map((result) => ({
      mode: result.mode,
      people: result.people,
      devices: result.devices,
      saves: result.saves,
      "head writes": result.headWrites,
      "head writes/drain": result.headWritesPerDrain,
      "heuristic retries/team write": result.heuristicRetriesPerScopeWrite.team,
      "heuristic retries/user write": result.heuristicRetriesPerScopeWrite.user,
      "heuristic retries/interest write":
        result.heuristicRetriesPerScopeWrite.interest ?? 0,
      "refused scopes/device mean": Number(
        result.refusedScopesPerDevice.mean.toFixed(2),
      ),
      "events/device mean": result.eventsPerDevice.mean,
      "events/device p95": result.eventsPerDevice.p95,
      "bytes/device mean": result.bytesPerDevice.mean.toFixed(0),
      "rows/device mean": result.rowsPerDevice.mean.toFixed(1),
    })),
  );
  console.log(
    "Note: population simulation uses polling; reactive getHeads behavior is tested separately.",
  );
}
