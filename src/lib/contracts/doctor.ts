import { Schema } from "effect";

export const DoctorCheck = Schema.Struct({
  id: Schema.String.pipe(Schema.pattern(/^[a-z][a-z0-9_]*$/u)),
  required: Schema.Boolean,
  ok: Schema.Boolean,
  message: Schema.NonEmptyString,
  fix: Schema.NullOr(Schema.NonEmptyString),
});

export const DoctorReport = Schema.Struct({
  schema: Schema.Literal("pulse.doctor"),
  schema_version: Schema.Literal(1),
  platform: Schema.NonEmptyString,
  checks: Schema.NonEmptyArray(DoctorCheck),
});

export type DoctorCheck = typeof DoctorCheck.Type;

export type DoctorReport = typeof DoctorReport.Type;
