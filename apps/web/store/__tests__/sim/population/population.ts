import { parseArgs } from "node:util";
import { runPopulation } from "./run";

const { values } = parseArgs({
  options: {
    people: { type: "string", default: "10" },
    devices: { type: "string" },
    seed: { type: "string", default: "42" },
    json: { type: "boolean" },
  },
});
const people = Number(values.people);
const devices =
  values.devices === undefined ? Math.min(people, 20) : Number(values.devices);
const seed = Number(values.seed);
if (!Number.isInteger(people) || people < 1 || people > 500)
  throw new Error("--people must be an integer from 1 to 500");
if (!Number.isInteger(devices) || devices < 1 || devices > Math.min(people, 50))
  throw new Error(
    "--devices must be an integer from 1 to the smaller of 50 and --people",
  );
if (!Number.isSafeInteger(seed)) throw new Error("--seed must be an integer");

const result = await runPopulation({ people, devices, seed });
if (values.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.table([
    {
      people,
      devices,
      saves: result.saves,
      "head writes": result.headWrites,
      "modeled retries/write": result.modeledRetriesPerWrite.toFixed(3),
      "drain lag p95 ms": result.drainLagMs.p95,
      "events/device mean": result.eventsPerDevice.mean.toFixed(1),
      "bytes/device mean": result.bytesPerDevice.mean.toFixed(0),
      "rows/device mean": result.rowsPerDevice.mean.toFixed(1),
    },
  ]);
}
