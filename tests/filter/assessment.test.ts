import { Either } from "effect";
import { describe, expect, it } from "vitest";
import { defaultPreferences } from "../../src/lib/server/profile/settings.ts";
import { assess, assessmentSortKey } from "../../src/lib/server/filter/assessment.ts";
import { decodeTitleEvidence } from "../../src/lib/server/filter/evidence-pack.ts";
import { matchesTerm, withoutReflexive } from "../../src/lib/server/filter/title-evidence.ts";

const neutral = () => null;
const score = (title: string, topics: readonly string[] = []) => assess(title, "Example", [], [], topics, defaultPreferences, neutral);

const pack = Either.getOrThrow(decodeTitleEvidence(new TextEncoder().encode(JSON.stringify({
  schema_version: 1,
  topics: [{ name: "rescue", pattern: "rescue|first aid" }],
  roles: [{ name: "rescue", pattern: "rescue instructor" }],
  source_tags: ["rescue"],
}))));

describe("deterministic title evidence", () => {
  it("ignores legacy Source tags and profession wording by default", () => {
    for (const title of ["Senior data scientist", "AI engineer", "Systems developer", "Rescue instructor"]) {
      expect(score(title, ["programming", "data science", "rescue"])).toMatchObject({
        classification: "uncertain", relevance_score: 0, signals: [], title_signals: [],
      });
    }
  });

  it("retains literal preferred terms without an installed pack", () => {
    const preferences = { ...defaultPreferences, preferred_terms: ["SQL", "C++"] };
    expect(assess("C++ and SQL adviser", "Example", [], [], ["programming"], preferences, neutral)).toMatchObject({
      classification: "adjacent", relevance_score: 1, signals: ["term: C++", "term: SQL"], title_signals: ["term: C++", "term: SQL"],
    });
  });

  it("uses explicit matching rules and treats selected stored tags as weak evidence", () => {
    const configured = (title: string, topics: readonly string[] = []) => assess(title, "Example", [], [], topics, defaultPreferences, neutral, pack);
    expect(configured("rescue instructor")).toMatchObject({ classification: "strong", title_signals: ["rescue"] });
    expect(configured("first aid course")).toMatchObject({ classification: "adjacent", title_signals: ["rescue"] });
    expect(configured("General adviser", ["rescue", "programming"])).toMatchObject({ classification: "uncertain", signals: ["rescue"], title_signals: [] });
  });

  it("removes complete reflexive phrases without erasing a separate literal match", () => {
    expect(withoutReflexive("xutvikler deg")).toBe("xutvikler deg");
    expect(withoutReflexive("utvikler degen")).toBe("utvikler degen");
    expect(matchesTerm("utvikler", "Her utvikler deg videre")).toBe(false);
    expect(matchesTerm("utvikler", "utvikler seg og Python utvikler")).toBe(true);
    expect(matchesTerm("utvikler deg", "Her utvikler deg videre")).toBe(true);
    expect(matchesTerm("  ", "Example")).toBe(false);
    expect(matchesTerm("(Python)", "x(Python)y")).toBe(false);
  });

  it("deduplicates synonyms and preserves exclusion ordering and mixed-location admission", () => {
    const preferences = { ...defaultPreferences, preferred_terms: ["rescue", "first aid", "C++"],
      excluded_title_terms: ["C++"], excluded_employers: ["  EXAMPLE  "], excluded_municipalities: ["A"],
      preferred_municipalities: ["B"], nearby_municipalities: ["A"], home_postcode: "1234" };

    const evaluate = (configured?: typeof pack) => assess("C++ rescue instructor, first aid", "Example", ["A", "B"], [], ["rescue"], preferences, () => "title exclusion: academic post", configured);

    const result = evaluate(pack);

    expect(result.signals).toEqual(["rescue", "term: C++"]);
    expect(result.excluded_reason).toBe("title exclusion: academic post; explicit title exclusion; explicit employer exclusion");
    expect(evaluate().excluded_reason).toBe(result.excluded_reason);
    expect(assessmentSortKey(result)).toEqual([-2, -2]);
    expect(assess("Example", "Else", ["B"], [" 1234 "], [], preferences, neutral)).toEqual(
      assess("Example", "Else", [], [], [], preferences, neutral),
    );
    expect(assess("Example", "Else", ["A"], [], [], preferences, neutral).excluded_reason).toBe("all known municipalities explicitly excluded");
  });
});
