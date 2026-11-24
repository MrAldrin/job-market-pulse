import { Effect, Option, Predicate } from "effect";
import type { TomlValue } from "smol-toml";
import { point } from "../lib/server/filter/geography.ts";
import type { PostcodeAreaError } from "../lib/server/profile/errors.ts";
import { postcodeAreaLabel, postcodeAreaOriginSource, type PostcodeArea } from "../lib/server/profile/postcode-area.ts";
import { pythonFloat } from "../lib/server/shared/python-json.ts";
import { strip } from "../lib/server/shared/text.ts";
import { InitInputError, type InitQuestions } from "./init-prompts.ts";

const coordinateInputs = ["latitude_input", "longitude_input"] as const;
const derivedOrigin = ["origin_latitude", "origin_longitude", "origin_source", "home_label"] as const;
const placeFields = [...coordinateInputs, ...derivedOrigin, "area_postcode"];
const manualControls = [...coordinateInputs, "lookup_place", "origin_mode"];

type SetupValue = TomlValue | undefined;

const numeric = (value: SetupValue): SetupValue => Predicate.isBigInt(value) ? Number(value) : value;

// Do not accept JavaScript-only integer prefixes, blank text or infinities.
const digits = "[0-9](?:_?[0-9])*";
const decimal = new RegExp(`^[+-]?(?:${digits}(?:\\.(?:${digits})?)?|\\.${digits})(?:[eE][+-]?${digits})?$`, "u");

const parseNumber = (raw: string): number => {
  const value = strip(raw);

  return decimal.test(value) ? Number(value.replaceAll("_", "")) : Number.NaN;
};

const numberAnswer = (ctx: InitQuestions, key: string, prompt: string, low: number, high: number, fallback?: string, exclusiveLow = false) => ctx.answer(key, {
  prompt,
  default: fallback,
  validate: (value) => {
    const parsed = parseNumber(value);

    if (Number.isFinite(parsed) && (exclusiveLow ? parsed > low : parsed >= low) && parsed <= high) return null;

    return exclusiveLow ? `Enter a finite number greater than ${low} and at most ${high}.` : `Enter a number from ${low} to ${high}.`;
  },
}).pipe(Effect.map(parseNumber));

interface Origin {
  readonly point: readonly [number, number];
  readonly label: string;
  readonly source: string;
}

const toOrigin = (latitude: SetupValue, longitude: SetupValue, label: SetupValue, source: SetupValue): Origin | null => {
  const coordinates = point(numeric(latitude), numeric(longitude));

  return coordinates && Predicate.isString(label) && Predicate.isString(source) ? { point: coordinates, label, source } : null;
};

interface AreaInput<R> {
  readonly date: string;
  readonly lookup: (postcode: string) => Effect.Effect<PostcodeArea, PostcodeAreaError, R>;
}

export const chooseSetupArea = <R>(ctx: InitQuestions, input: AreaInput<R>) => Effect.gen(function* () {
  yield* ctx.say("Jobs outside your area are removed before the AI sees them.");
  yield* ctx.say("Enter the postcode of your work area. Distance is straight-line, not travel distance.");

  const saved = ctx.committedDefaults;
  const savedQuery = saved.area_postcode ?? saved.home_label;
  const explicitQuery = ctx.current("place_query") ?? savedQuery;
  let previousQuery = explicitQuery;

  const invalidate = (query: string): void => {
    if (query === previousQuery) return;

    for (const key of placeFields) if (query !== explicitQuery || !ctx.explicitKeys.has(key)) ctx.forget(key);
    previousQuery = query;
  };

  const committed = toOrigin(saved.origin_latitude, saved.origin_longitude, saved.home_label, saved.origin_source);
  const hasRecoveredOrigin = () => derivedOrigin.every((key) => ctx.recoveredKeys.has(key));
  let origin: Origin | null = null;

  if (committed || hasRecoveredOrigin()) {
    const query = yield* ctx.answer("place_query", {
      prompt: "Work-area postcode (Enter keeps the saved area)",
      default: Predicate.isString(savedQuery) ? savedQuery : undefined,
    });

    invalidate(query);

    const recovered = toOrigin(ctx.current("origin_latitude"), ctx.current("origin_longitude"), ctx.current("home_label"), ctx.current("origin_source"));
    const changed = [...coordinateInputs, ...derivedOrigin].some((key) => ctx.recoveredKeys.has(key) && numeric(ctx.current(key)) !== numeric(saved[key]));
    const explicitOrigin = manualControls.some((key) => ctx.explicitKeys.has(key));

    if (recovered && changed && hasRecoveredOrigin() && !explicitOrigin && coordinateInputs.every((key, index) =>
      !ctx.recoveredKeys.has(key) || ctx.current(key) === saved[key] || ctx.current(key) === pythonFloat(recovered.point[index === 0 ? 0 : 1]))) origin = recovered;

    if (committed && query === savedQuery && !changed && !explicitOrigin) origin = committed;
  }

  if (!origin) for (const key of [...coordinateInputs, "home_label"]) {
    if (!ctx.explicitKeys.has(key) && !ctx.recoveredKeys.has(key)) ctx.forget(key);
  }

  while (!origin) {
    let manual = coordinateInputs.some((key) => ctx.explicitKeys.has(key) || ctx.recoveredKeys.has(key)) ||
      ctx.current("lookup_place") === "no" || ctx.current("origin_mode") === "manual";

    if (ctx.advanced && !manual) manual = (yield* ctx.answer("origin_mode", {
      prompt: "Origin: postcode or manual?",
      default: "postcode",
      validate: (value) => value === "postcode" || value === "manual" ? null : "Choose postcode or manual.",
    })) === "manual";

    if (manual) {
      const latitude = yield* numberAnswer(ctx, "latitude_input", "Latitude", -90, 90);
      const longitude = yield* numberAnswer(ctx, "longitude_input", "Longitude", -180, 180);
      const label = yield* ctx.answer("home_label", { prompt: "Label for this area", default: String(ctx.current("place_query") ?? "Work area") });
      origin = { point: [latitude, longitude], label, source: "entered by hand" };
      ctx.answers.area_postcode = "";
      break;
    }

    const query = yield* ctx.answer("place_query", {
      prompt: "Four-digit work-area postcode",
      validate: (value) => /^[0-9]{4}$/u.test(value) ? null : "Enter four digits, including leading zeroes.",
    });

    invalidate(query);

    const area = yield* input.lookup(query).pipe(Effect.option);

    if (Option.isNone(area)) {
      yield* ctx.say("Postal-area lookup failed: no unique, usable area was established. Try another postcode. For manual coordinates use pulse init --advanced --step geography.");

      if (ctx.nonInteractive || ctx.explicitKeys.has("place_query")) return yield* new InitInputError({ message: "No usable area for the supplied place_query." });
      ctx.forget("place_query");
      continue;
    }

    const label = postcodeAreaLabel(area.value);
    origin = toOrigin(area.value.latitude, area.value.longitude, label, postcodeAreaOriginSource(area.value, input.date));
    ctx.answers.area_postcode = area.value.postcode;
    yield* ctx.say(`Area: ${label}`);

    if (!origin) return yield* new InitInputError({ message: "The selected place has invalid coordinates." });
  }

  const [latitude, longitude] = origin.point;
  const radius = yield* numberAnswer(ctx, "radius_input", "How far from there, in km?", 0, 1000, "30", true);
  const answers = { origin_latitude: latitude, origin_longitude: longitude, origin_source: origin.source, radius_km: radius, home_label: origin.label };
  const postcode = ctx.current("area_postcode");
  Object.assign(ctx.answers, answers);

  return Predicate.isString(postcode) ? { ...answers, area_postcode: postcode } : answers;
});
