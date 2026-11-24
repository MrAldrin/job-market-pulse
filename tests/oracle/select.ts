import { FileSystem } from "@effect/platform";
import { Effect, Schema } from "effect";
import { digestTimestamp, DigestCandidate, type Digest, type DigestRequest } from "../../src/lib/contracts/select.ts";
import { parseRequest, selectDigest } from "../../src/lib/server/select/core.ts";
import { renderHtml, renderText } from "../../src/lib/server/select/digest-render.ts";
import { pythonJson } from "../../src/lib/server/shared/python-json.ts";
import { compareText } from "./compare.ts";

export const digestBundles = ["basic-run", "resume-run", "duplicate-alert", "viewer-api"] as const;
const Pair = Schema.Tuple(Schema.String, Schema.Literal("pass", "fail", "unknown"));
const RecordedCandidate = Schema.Struct({ ...DigestCandidate.from.fields, hard_constraints: Schema.Array(Pair) });

const RecordedRequest = Schema.Struct({
  profile_id: Schema.String, profile_fingerprint: Schema.String,
  pack: Schema.NullOr(Schema.Struct({ id: Schema.String, fingerprint: Schema.String })),
  mode: Schema.Literal("passive", "active"),
  snapshot: Schema.Struct({ checked_at: Schema.String, caught_up: Schema.Boolean }),
  assessments_complete: Schema.Boolean, hard_constraint_names: Schema.Array(Schema.String),
  candidates: Schema.Array(RecordedCandidate), delivered: Schema.Array(Schema.Tuple(Schema.String, Schema.String)),
  market_context: Schema.NullOr(Schema.String), include_market_only: Schema.Boolean,
});

export const produceDigestBoundary = (bundle: typeof digestBundles[number]) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = `tests/oracle/${bundle}/select`;
  const recorded = yield* fs.readFileString(path + "/request.json").pipe(Effect.flatMap(Schema.decodeUnknown(Schema.parseJson(RecordedRequest))));
  const { hard_constraint_names: names, ...fields } = recorded;

  const request = yield* parseRequest({ ...fields, schema_version: 1n,
    hard_constraints: names,
    candidates: recorded.candidates.map((candidate) => ({ ...candidate,
      assessed_at: digestTimestamp(candidate.assessed_at), expires_at: candidate.expires_at === null ? null : digestTimestamp(candidate.expires_at),
      hard_constraints: Object.fromEntries(candidate.hard_constraints),
    })), delivered: recorded.delivered.map(([id, version]) => ({ id, version })),
  });

  const digest = yield* selectDigest(request, request.snapshot.checked_at);

  return { bundle, request, digest, json: recordedDigest(digest, request), text: yield* renderText(digest), html: yield* renderHtml(digest) };
});

export const recordedDigest = (digest: Digest, request: DigestRequest): string => pythonJson({
  ...digest, as_of: digestTimestamp(digest.as_of), candidates: digest.candidates.map((candidate) => ({ ...candidate,
    assessed_at: digestTimestamp(candidate.assessed_at), expires_at: candidate.expires_at === null ? null : digestTimestamp(candidate.expires_at),
    hard_constraints: request.hard_constraints.map((name) => [name, candidate.hard_constraints[name] ?? "unknown"]), salary: "Lønn ukjent",
  })),
}, false, true);

export const compareDigestBoundaries = Effect.forEach(digestBundles, (bundle) => produceDigestBoundary(bundle).pipe(
  Effect.tap((result) => Effect.all([compareText(`tests/oracle/${bundle}/select/digest.json`, result.json), compareText(`tests/oracle/${bundle}/select/digest.txt`, result.text), compareText(`tests/oracle/${bundle}/select/digest.html`, result.html)])),
), { concurrency: 1 });
