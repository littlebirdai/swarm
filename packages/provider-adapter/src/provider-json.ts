import type { EdgeJson } from "@codecast/edge-contract";
import * as Schema from "effect/Schema";

export const json: Schema.Codec<EdgeJson> = Schema.suspend(() =>
  Schema.Union([
    Schema.Null,
    Schema.Boolean,
    Schema.Finite,
    Schema.String,
    Schema.mutable(Schema.Array(json)),
    Schema.Record(Schema.String, json),
  ]),
);
