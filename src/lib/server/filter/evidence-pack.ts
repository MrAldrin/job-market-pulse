import { FileSystem } from "@effect/platform";
import { Effect, Either, Option, Schema } from "effect";
import { nonemptyText } from "../../contracts/support.ts";
import { readBoundedFile } from "../shared/bounded-file.ts";
import { checkedInstallationSetting } from "../shared/paths.ts";
import { pythonJson, sha256 } from "../shared/python-json.ts";
import { parseStrictContractBytes } from "../shared/strict-contract-json.ts";
import { FilterInputError } from "./errors.ts";
import { NEUTRAL_TITLE_EVIDENCE, type TitleEvidence } from "./title-evidence.ts";

export const INTEREST_PATTERNS_PATH = "local_only/config/interest-patterns.json";
const MAX_BYTES = 2_000_000;
const label = nonemptyText.pipe(Schema.maxLength(128), Schema.filter((name) => !name.startsWith("term: ")));
const rules = Schema.Array(Schema.Struct({ name: label, pattern: nonemptyText })).pipe(Schema.maxItems(64));
const pack = Schema.Struct({ schema_version: Schema.Literal(1n), topics: rules, roles: rules, source_tags: Schema.Array(label).pipe(Schema.maxItems(64)) });
const invalid = () => new FilterInputError({ message: "Invalid Filter interest patterns" });
const unreadable = () => new FilterInputError({ message: "Cannot read Filter interest patterns" });
const unique = (items: readonly string[]): boolean => new Set(items).size === items.length;
const compile = (items: typeof rules.Type) => items.map(({ name, pattern }) => ({ name, regex: new RegExp(pattern, "u") }));
const matcher = (items: ReturnType<typeof compile>) => (text: string): readonly string[] => items.filter(({ regex }) => regex.test(text)).map(({ name }) => name);
const effective = (items: ReturnType<typeof compile>) => items.map(({ name, regex }) => ({ name, pattern: regex.source }));

// Pin the complete ordered legacy matcher sources and Source tag allowlist.
// Never derive the old version from a label, user flag or partial match.
const legacyDigest = "77b2663ff4529b056df2d5bcfa8ace9eb792dae11b50c901e00774047499d224";

export const decodeTitleEvidence = (bytes: Uint8Array): Either.Either<TitleEvidence, FilterInputError> => Either.gen(function* () {
  const raw = yield* Either.mapLeft(parseStrictContractBytes(bytes, MAX_BYTES), invalid);
  const data = yield* Either.mapLeft(Schema.decodeUnknownEither(pack, { onExcessProperty: "error" })(raw), invalid);

  if (!unique(data.topics.map(({ name }) => name)) || !unique(data.roles.map(({ name }) => name)) || !unique(data.source_tags)) return yield* Either.left(invalid());

  if (!data.topics.length && !data.roles.length && !data.source_tags.length) return NEUTRAL_TITLE_EVIDENCE;

  return yield* Either.try({ try: () => {
    const topics = compile(data.topics);
    const roles = compile(data.roles);
    const sourceTags = [...data.source_tags];
    const digest = sha256(pythonJson({ ...data, topics: effective(topics), roles: effective(roles), source_tags: sourceTags }));

    return {
      scoringVersion: digest === legacyDigest ? "title-evidence-hard-radius-v3" : `title-evidence-pack-v1-${digest}`,
      topics: matcher(topics), roles: matcher(roles), sourceTags: new Set(sourceTags),
    };
  }, catch: invalid });
});

const notLink = Schema.is(Schema.Struct({ code: Schema.Literal("EINVAL") }));

export const loadTitleEvidence = (root: string): Effect.Effect<TitleEvidence, FilterInputError, FileSystem.FileSystem> => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* checkedInstallationSetting(root, INTEREST_PATTERNS_PATH);
  const info = yield* fs.stat(path).pipe(Effect.map(Option.some), Effect.catchTag("SystemError", (error) => error.reason === "NotFound" ? Effect.succeed(Option.none()) : Effect.fail(error)));

  if (Option.isNone(info)) {
    const link = yield* fs.readLink(path).pipe(Effect.as(true), Effect.catchTag("SystemError", (error) => error.reason === "NotFound" || notLink(error.cause) ? Effect.succeed(false) : Effect.fail(error)));

    if (link) return yield* unreadable();

    return NEUTRAL_TITLE_EVIDENCE;
  }

  if (info.value.type !== "File" || info.value.size > BigInt(MAX_BYTES)) return yield* unreadable();
  const bytes = yield* readBoundedFile(path, MAX_BYTES);

  return yield* decodeTitleEvidence(bytes);
}).pipe(Effect.mapError((error) => error instanceof FilterInputError ? error : unreadable()));
