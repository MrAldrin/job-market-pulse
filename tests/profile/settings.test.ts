import { Either, Schema } from "effect";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { TomlDate } from "smol-toml";
import { ProfileBundle } from "../../src/lib/contracts/profile.ts";
import { awareTimestamp, decodeStrict } from "../../src/lib/contracts/support.ts";
import { decodeProfileSettings, initialProfileConfig, parseCadence, replaceModeText, weekDue } from "../../src/lib/server/profile/core.ts";
import { decodeFilters, decodeJudge, decodeScreen, defaultPreferences, mergePreferences, preferenceVersion } from "../../src/lib/server/profile/settings.ts";
import { splitSettingsText } from "../../src/lib/server/profile/split-settings.ts";
import { parseToml } from "../../src/lib/server/shared/toml.ts";
import { caseFold, decimalDigit, normalized, printable, strip, words } from "../../src/lib/server/shared/text.ts";
import { parseJsonInput } from "../../src/lib/server/shared/json-input.ts";
import { PythonFloat, pythonFloat, pythonJson } from "../../src/lib/server/shared/python-json.ts";

const unwrap = <A, E>(result: Either.Either<A, E>): A => Either.getOrThrow(result);
const config = unwrap(initialProfileConfig("invented"));
const rules = 'version = "synthetic-v1"\nacademic = []\nsales = []\nbusiness_development = []\ntech_words = []\n';

const preferences = (text: string) => {
  const split = unwrap(splitSettingsText(text, rules));
  const filters = unwrap(decodeFilters(split.filters));

  return unwrap(mergePreferences(filters, unwrap(decodeJudge(split.judge))));
};

describe("strict owned settings and exact identity", () => {
  it("assigns each job key to exactly one owner", () => {
    expect(Either.isLeft(decodeFilters('[jobs]\npreferred_terms = ["x"]'))).toBe(true);
    expect(Either.isLeft(decodeJudge('[jobs]\nexcluded_employers = ["x"]'))).toBe(true);
    expect(Either.isLeft(decodeScreen('geography = {}'))).toBe(true);
    expect(Either.isLeft(decodeFilters('[unknown]\nx = true'))).toBe(true);
    expect(Either.isLeft(decodeJudge('unknown = true'))).toBe(true);
    // Raw patterns are data. B4 must compile, validate and execute Python-compatible regex.
    expect(Either.isRight(decodeScreen('version = 7\nacademic = ["(?P<python>valid)", "["]'))).toBe(true);
  });
  it.each(['radius_km = 0', 'radius_km = 1001', 'radius_km = true', 'radius_km = nan', 'radius_km = inf', 'home_postcode = "123"', 'home_label = " "'])("rejects invalid geography %s", (entry) => {
    expect(Either.isLeft(decodeFilters('[geography]\n' + entry))).toBe(true);
  });
  it("requires the entire origin tuple, not an invented partial default", () => {
    for (const text of ['origin_latitude = 60', 'origin_latitude = 60\norigin_longitude = 10', 'origin_source = "x"']) {
      expect(Either.isLeft(mergePreferences(unwrap(decodeFilters('[geography]\n' + text)), {}))).toBe(true);
    }

    expect(preferences('[geography]\norigin_latitude = 60\norigin_longitude = 10\norigin_source = " invented "').origin_source).toBe("invented");
    expect(preferences('[geography]\nhome_postcode = " １２３４ "').home_postcode).toBe("１２３４");
  });
  it("keeps existing defaults, normalized stable lists and explicit empty overrides", () => {
    expect(preferences("")).toEqual(defaultPreferences);
    const split = unwrap(splitSettingsText('[jobs]\npreferred_terms = []\nexcluded_employers = [" Straße ", "STRASSE", "A  B"]', rules, '[jobs]\npreferred_terms = ["inherited"]'));
    const value = unwrap(mergePreferences(unwrap(decodeFilters(split.filters)), unwrap(decodeJudge(split.judge))));
    expect(value.preferred_terms).toEqual([]);
    expect(value.excluded_employers).toEqual(["Straße", "A B"]);
  });
  it("preserves inherited integer radius versus local float radius and default float", () => {
    const inherited = unwrap(splitSettingsText("", rules, '[geography]\nradius_km = 12'));
    const local = unwrap(splitSettingsText('[geography]\nradius_km = 12', rules));

    const identity = (text: string) => {
      const filter = unwrap(decodeFilters(text));
      const prefs = unwrap(mergePreferences(filter, {}));

      return preferenceVersion(prefs, filter.geography?.radius_km ?? prefs.radius_km);
    };

    expect(inherited.filters).toContain("radius_km = 12\n");
    expect(local.filters).toContain("radius_km = 12.0\n");
    expect(identity(inherited.filters)).not.toBe(identity(local.filters));
    expect(preferenceVersion(preferences(""))).not.toBe(identity(local.filters));
    expect(unwrap(decodeFilters(inherited.filters)).geography?.radius_km).toBe(12n);
    expect(unwrap(decodeFilters(local.filters)).geography?.radius_km).toBe(12);
  });
  it("ignores legacy location keys without changing the matching hash", () => {
    const original = preferences('[geography]\nradius_km = 40');
    const metadata = unwrap(mergePreferences(unwrap(decodeFilters('[geography]\nradius_km = 40.0\nhome_label = "Invented"\narea_postcode = "１２３４"\npreferred_municipalities = true\nnearby_municipalities = [""]')), {}));
    expect(preferenceVersion(metadata)).toBe(preferenceVersion(original));
    expect(preferenceVersion({ ...original, preferred_terms: ["new"] })).not.toBe(preferenceVersion(original));
  });
  it.each(['5.0', '5e0', 'true', '"5"', '0', '11'])("refuses a non-integer-token or invalid review batch %s", (value) => {
    expect(Either.isLeft(decodeProfileSettings(config + '\n[review]\nfull_review_batch_size = ' + value))).toBe(true);
  });
  it("keeps legacy Profile extras inert while known fields and split ownership remain strict", () => {
    const extended = config.replace("[profile]", '[profile]\nignored = { path = "/never/read/this" }\ntimezone = false')
      .replace("[paths]", '[paths]\nignored_path = "/never/read/that"')
      .replace("[policy]", '[policy]\nunused_nan = nan\nunused_date = 2026-11-12')
      + '\n[unrelated]\nmode = "passive"\nopaque = \'\'\'\nmode = "passive"\n\'\'\'\n'
      + "deep = " + "[".repeat(80) + "7" + "]".repeat(80) + '\n[__proto__]\npolluted = true\n[constructor]\ninert = true\n';

    expect(Either.isRight(decodeProfileSettings(extended))).toBe(true);
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
    expect(unwrap(replaceModeText(extended, "active"))).toBe(extended.replace('mode = "passive"\nmarket_only', 'mode = "active"\nmarket_only'));
    expect(Either.isLeft(decodeProfileSettings(extended.replace("freshness_max_age_hours = 24", "freshness_max_age_hours = nan")))).toBe(true);
    expect(Either.isLeft(decodeFilters('[geography]\nunknown = true'))).toBe(true);
    expect(Either.isLeft(decodeJudge('[jobs]\nunknown = []'))).toBe(true);
    expect(Either.isLeft(decodeScreen('unknown = []'))).toBe(true);
  });
  it("preserves TOML date versus datetime versus string tokens", () => {
    const weekly = config + '\ncadence = "fortnightly"\ncadence_anchor = ';
    expect(unwrap(parseCadence(unwrap(decodeProfileSettings(weekly + '2026-11-12')).policy))).toEqual({ kind: "fortnightly", anchor: "2026-11-12" });
    expect(unwrap(parseCadence(unwrap(decodeProfileSettings(weekly + '"2026-11-12"')).policy)).anchor).toBe("2026-11-12");
    expect(unwrap(parseToml('date = 2026-11-12')).date).toBeInstanceOf(TomlDate);

    for (const token of ['2026-11-12T00:00:00Z', '"2026-02-30"', '"20261112"']) {
      const decoded = decodeProfileSettings(weekly + token);
      expect(Either.isLeft(Either.flatMap(decoded, (value) => parseCadence(value.policy)))).toBe(true);
    }
  });
  it("fortnightly parity includes pre-anchor ISO weeks", () => {
    const cadence = { kind: "fortnightly" as const, anchor: "2026-11-12" };
    expect(unwrap(weekDue(cadence, "2026-11-01"))).toBe(true);
    expect(unwrap(weekDue(cadence, "2026-11-02"))).toBe(false);
    expect(unwrap(weekDue(cadence, "2026-11-22"))).toBe(false);
    expect(unwrap(weekDue(cadence, "2026-11-23"))).toBe(true);
    expect(Either.isLeft(weekDue(cadence, "2026-02-30"))).toBe(true);
  });
  it("retains Python case folding and whitespace, not JS-only trimming", () => {
    expect(caseFold("Straße ſun Σςﬃ")).toBe("strasse sun σσffi");
    expect(words("a\u001cb\u0085c\ufeffd")).toEqual(["a", "b", "c\ufeffd"]);
    expect(strip("\u001c x \u0085")).toBe("x");
    expect(strip("\ufeffx\ufeff")).toBe("\ufeffx\ufeff");
    expect(printable(String.fromCodePoint(0x1cc00))).toBe(false); // Assigned only after Unicode 15.1.
    expect(decimalDigit(String.fromCodePoint(0x1e5f1))).toBe(false);
    expect(decimalDigit(String.fromCodePoint(0x1e4f1))).toBe(true);
    expect(Either.isLeft(decodeFilters('[geography]\nhome_postcode = "' + String.fromCodePoint(0x1e5f1).repeat(4) + '"'))).toBe(true);
    fc.assert(fc.property(fc.string(), (value) => { expect(normalized(normalized(value))).toBe(normalized(value)); }));
  });
  it("retains exact raw JSON integer versus float tokens without rounding large identities", () => {
    expect(unwrap(parseJsonInput('[1,1.0,1e0,9007199254740993]'))).toEqual([1n, 1, 1, 9007199254740993n]);
    expect(pythonJson({ z: new PythonFloat(25), a: 12n })).toBe('{"a":12,"z":25.0}');
    expect(pythonFloat(1e-7)).toBe("1e-07");
    expect(pythonFloat(1e16)).toBe("1e+16");
    expect(pythonFloat(-0)).toBe("-0.0");
  });
  it("the shared timestamp boundary requires a valid date and explicit zone", () => {
    for (const value of ["2026-11-12T12:00:00Z", "2026-11-12T13:00:00.123456+01:00"]) expect(Either.isRight(decodeStrict(awareTimestamp)(value))).toBe(true);

    for (const value of ["2026-02-30T12:00Z", "2026-11-12T12:00", "2026-11-12T12:00Z\n"]) expect(Either.isLeft(decodeStrict(awareTimestamp)(value))).toBe(true);
    expect(Either.isLeft(decodeStrict(Schema.Struct({ value: Schema.Boolean }))({ value: "true" }))).toBe(true);
    expect(Either.isLeft(decodeStrict(ProfileBundle)({ schema: "new-version", schema_version: 2 }))).toBe(true);
  });
  it("changes only one parsed policy mode and preserves all other bytes", () => {
    const source = config.replace('mode = "passive"', 'mode = \'passive\' # keep') + '\n[unrelated]\nmode = "passive"\nnan_value = nan\nopaque = \'\'\'\nmode = "passive"\n\'\'\'\n';
    expect(unwrap(replaceModeText(source, "active"))).toBe(source.replace("mode = 'passive'", "mode = 'active'"));
    expect(unwrap(replaceModeText(source, "passive"))).toBe(source);
    expect(Either.isLeft(replaceModeText(config.replace('mode = "passive"', 'mode = """passive"""'), "active"))).toBe(true);
    expect(Either.isLeft(replaceModeText(config, "ACTIVE"))).toBe(true);
  });
});
