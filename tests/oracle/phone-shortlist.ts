import { FileSystem } from "@effect/platform";
import { Effect, Layer, Schema } from "effect";
import { PhoneShortlist, PhoneShortlistLive, SavedReviewResource } from "../../src/lib/server/select/phone-shortlist.ts";
import { selectShortlist, type SavedCandidate } from "../../src/lib/server/select/shortlist-select.ts";
import { JsonInput, parseJsonInput } from "../../src/lib/server/shared/json-input.ts";
import { PythonFloat, pythonJson, type PythonJson } from "../../src/lib/server/shared/python-json.ts";
import { compareText } from "./compare.ts";

export const phoneBundles = ["basic-run", "viewer-api", "duplicate-alert", "resume-run"] as const;

const projection = Schema.Struct({ listing_id: Schema.String, lifecycle_status: Schema.String,
  full_review: Schema.NullOr(Schema.Struct({ fit: Schema.optional(Schema.String), reason: Schema.optional(Schema.String) })),
  title: Schema.String, employer: Schema.String, application_due: Schema.NullOr(Schema.String), expires_at: Schema.NullOr(Schema.String), source_version: Schema.NullOr(Schema.String),
});

type RecordedCandidate = SavedCandidate & Readonly<Record<string, JsonInput>>;

// Preserve all recorded Judge output fields without making them a Select wire
// contract or importing Judge's private table implementation.
const RecordedCandidate = Schema.declare<RecordedCandidate>((value): value is RecordedCandidate => Schema.is(JsonInput)(value) && Schema.is(projection)(value));
const savedSchema = Schema.Struct({ candidates: Schema.Array(RecordedCandidate) });
const snapshotSchema = Schema.Struct({ generated_at: Schema.String, profile: Schema.Struct({ id: Schema.String, mode: Schema.Literal("passive", "active") }), jobs: Schema.Array(Schema.Struct({ id: Schema.String, first_found_at: Schema.NullOr(Schema.String) })) });

const recordedJson = (value: JsonInput): PythonJson => {
  if (Schema.is(Schema.Number)(value)) return new PythonFloat(value);

  if (Array.isArray(value)) return value.map(recordedJson);

  if (Schema.is(Schema.Record({ key: Schema.String, value: JsonInput }))(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, recordedJson(item)]));

  return value;
};

export const producePhoneBoundary = (bundle: typeof phoneBundles[number]) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const savedRaw = yield* fs.readFileString(`tests/oracle/${bundle}/judge/current-snapshot.json`).pipe(Effect.flatMap(parseJsonInput));
  const saved = yield* Schema.decodeUnknown(savedSchema)(savedRaw);
  const snapshot = yield* fs.readFileString(`tests/oracle/${bundle}/snapshot/snapshot-v1.json`).pipe(Effect.flatMap(Schema.decodeUnknown(Schema.parseJson(snapshotSchema))));
  const firstFound = new Map<string, string>();

  for (const job of snapshot.jobs) if (job.first_found_at !== null) firstFound.set(job.id, job.first_found_at);
  const listingIds = new Set(snapshot.jobs.map((job) => job.id));
  const found = Object.fromEntries(firstFound);
  const selected = selectShortlist(saved.candidates.filter((item) => listingIds.has(item.listing_id)), found, snapshot.profile.mode);
  const resource = Layer.succeed(SavedReviewResource, { read: Effect.succeed({ verified: true, listingIds: [...listingIds], candidates: saved.candidates, firstFound: found }) });
  const result = yield* Effect.flatMap(PhoneShortlist, (service) => service.capture(snapshot.profile.id, snapshot.profile.mode, new Date(snapshot.generated_at))).pipe(Effect.provide(PhoneShortlistLive.pipe(Layer.provide(resource))));

  return { bundle, html: new TextDecoder().decode(result.html), json: pythonJson(selected.map(recordedJson), false, true) };
});

export const comparePhoneBoundaries = Effect.forEach(phoneBundles, (bundle) => producePhoneBoundary(bundle).pipe(
  Effect.tap(({ html, json }) => Effect.all([compareText(`tests/oracle/${bundle}/select/shortlist.html`, html), compareText(`tests/oracle/${bundle}/select/shortlist.json`, json)])),
), { concurrency: 1 });
