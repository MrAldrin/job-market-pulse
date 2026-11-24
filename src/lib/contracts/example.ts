import { Schema } from "effect";

// Scaffold example only. No product wire contract is changed.
export const ExampleContract = Schema.Struct({
  schema: Schema.Literal("pulse.example"),
  schema_version: Schema.Literal(1),
  message: Schema.String,
});

export const decodeExample = Schema.decodeUnknown(ExampleContract, { onExcessProperty: "error" });
