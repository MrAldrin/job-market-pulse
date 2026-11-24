import { Either } from "effect";
import { describe, expect, it } from "vitest";
import { compileScreenRules } from "../../src/lib/server/filter/screen-rules.ts";
import { readScreenTerm, screenListView, screenTermPattern, titleScreenTerm } from "../../src/lib/title-screen-terms.ts";
import { manualScreen } from "../../src/lib/server/filter/screen-context.ts";
import { makeSourcePolicy, type SourceSnapshot } from "../../src/lib/server/filter/source-policy.ts";
import { filterSettings, sourceAd } from "./fixtures.ts";

const raw = String.raw;

describe("real non-neutral Screen context compilation", () => {
  const rules = {
    academic: [raw`\bsynthetic\s+fellow\w*`], business_development: [raw`\bbusiness\s+developer\w*`],
    sales: [raw`\bsales\b`], tech_words: [raw`\b(?:engineer|utvikler|data)\w*`],
  };

  it("compiles public synthetic families with retained precedence and reflexive removal", () => {
    const context = Either.getOrThrow(compileScreenRules(rules, "a".repeat(64)));

    expect(context.rules_fingerprint).toBe("a".repeat(64));
    expect(context.excludeTitle("SYNTHETIC FELLOW engineer")).toBe("title exclusion: academic post");
    expect(context.excludeTitle("Business Developer engineer")).toBe("title exclusion: business development role");
    expect(context.excludeTitle("Sales manager")).toBe("title exclusion: sales role without tech title words");
    expect(context.excludeTitle("Sales engineer")).toBeNull();
    expect(context.excludeTitle("Sales: utvikler seg")).toBe("title exclusion: sales role without tech title words");
    expect(context.excludeTitle("Sales engineer")).toBeNull();
  });

  it("converts a plain phrase or prefix to case-insensitive Unicode title rules", () => {
    const exact = screenTermPattern("åpen dag");
    const prefix = screenTermPattern("utvikler*");

    const screen = Either.getOrThrow(compileScreenRules({ academic: [exact, prefix] }, "a".repeat(64)));

    for (const title of ["Åpen   dag", "Senior utviklerstilling"]) expect(screen.excludeTitle(title)).not.toBeNull();

    for (const title of ["Uåpen dag", "Åpen daglig", "Hovedutvikler"]) expect(screen.excludeTitle(title)).toBeNull();
    expect(readScreenTerm(exact)).toBe("åpen dag");
    expect(readScreenTerm(prefix)).toBe("utvikler*");
    expect(readScreenTerm(raw`\bengineer*\b`)).toBeUndefined();
    expect(screenListView([...rules.academic, ...rules.sales, ...rules.tech_words])).toEqual({
      terms: ["synthetic fellow*", "sales"], advanced: rules.tech_words,
    });

    for (const input of ["*", "abc.*", "ab*c", "ab|cd", "abc\n"]) expect(titleScreenTerm.test(input)).toBe(false);
  });

  it("uses actual compiled rules across the structural Source callbacks", () => {
    const settings = { ...filterSettings(), screen: rules };
    const policy = Either.getOrThrow(makeSourcePolicy(settings, new Map()));
    const blocked = sourceAd(undefined, "Synthetic Fellow engineer");
    const allowed = sourceAd("00000000-0000-4000-8000-000000000002", "Engineer");

    const snapshot: SourceSnapshot = {
      ads: [blocked, allowed],
      occupation_pairs: { [blocked.uuid]: [["IT", "Engineer"]], [allowed.uuid]: [["IT", "Engineer"]] },
      location_points: { [blocked.uuid]: [[[0, 0]], false], [allowed.uuid]: [[[0, 0]], false] },
    };

    expect(policy.rankMissing(snapshot.ads).map((row) => row.uuid)).toEqual([blocked.uuid, allowed.uuid]);
    expect(policy.locationCandidates(snapshot).map((row) => row.uuid)).toEqual([allowed.uuid]);
    expect(policy.insideJobs(snapshot).map((row) => row.uuid)).toEqual([allowed.uuid]);
  });

  it("compiles the Profile context when manual callers omit an already-compiled override", () => {
    const base = filterSettings();
    const context = Either.getOrThrow(manualScreen({ ...base, screen: rules }));

    expect(context.rules_fingerprint).toBe(base.rules_fingerprint);
    expect(context.excludeTitle("Sales manager")).not.toBeNull();
    const invalid = { ...base, screen: { ...rules, tech_words: ["[invalid"] } };

    const manual = manualScreen(invalid);
    const override = manualScreen(invalid, context);
    const source = makeSourcePolicy(invalid, new Map());

    expect(Either.isLeft(manual) && manual.left._tag).toBe("ScreenCompilationError");
    expect(Either.isLeft(override) && override.left._tag).toBe("ScreenCompilationError");
    expect(Either.isLeft(source) && source.left._tag).toBe("ScreenCompilationError");
  });
});
