import { FileSystem } from "@effect/platform";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect, Either } from "effect";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { adjustableSections, type Answers, checkNarrative, decodeAnswers, decodeQuestions, fillTemplate, hasMeaningfulContent, normalizeSalary, normalizeWorkplace, renderAnswers, replaceSection, sections } from "../../src/lib/server/profile/narrative.ts";
import { NarrativeResources, narrativeResourcesLayer } from "../../src/lib/server/profile/narrative-service.ts";

const template = readFileSync("skills/pulse-interview/profile-template.md", "utf8");
const bankText = readFileSync("skills/pulse-interview/questions.toml", "utf8");
const questions = Either.getOrThrow(decodeQuestions(bankText));
const encode = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array) => new TextDecoder().decode(value);
const render = (answers: Answers, short = false) => Either.getOrThrow(renderAnswers(template, questions, answers, short));

test("narrative question bank retains all 28 questions and nine short questions in source order", () => {
  expect(questions).toHaveLength(28);
  expect(Either.getOrThrow(decodeQuestions(bankText, true))).toHaveLength(9);
  expect(questions[0]?.id).toBe("current_role");
  expect(questions.at(-1)?.id).toBe("no_examples");
  expect(Either.isLeft(decodeQuestions('question = [{id = "wrong"}]'))).toBe(true);
  expect(Either.isLeft(decodeQuestions(bankText + '\nextra = true'))).toBe(true);
});

test("narrative salary keeps positive whole NOK exactly, including arbitrarily large values", () => {
  expect(Either.getOrThrow(normalizeSalary(" 000700000 "))).toBe("700000");
  expect(Either.getOrThrow(normalizeSalary("\u0085000700000\u0085"))).toBe("700000");
  expect(Either.isLeft(normalizeSalary("\uFEFF700000"))).toBe(true);
  expect(Either.getOrThrow(normalizeSalary(""))).toBe("");

  for (const value of ["-4", "4.5", "1 NOK", "0", "000"]) expect(Either.isLeft(normalizeSalary(value))).toBe(true);
  const huge = "123456789012345678901234567890";
  expect(render({ interview_minimum_salary: "000" + huge })).toContain("123,456,789,012,345,678,901,234,567,890 NOK");
  expect(render({ interview_minimum_salary: "700000" })).toContain("salary compatibility is unknown");
  fc.assert(fc.property(fc.bigInt({ min: 1n, max: 10n ** 50n }), (amount) => {
    expect(Either.getOrThrow(normalizeSalary("000" + amount.toString()))).toBe(amount.toString());
  }));
});

test("narrative workplace selections and explicit strict/prefer/unknown remain distinct", () => {
  expect(Either.getOrThrow(normalizeWorkplace("3, 1 2"))).toBe("1,2,3");
  expect(Either.getOrThrow(normalizeWorkplace("1,\u00852"))).toBe("1,2");
  expect(Either.isLeft(normalizeWorkplace("1,\uFEFF2"))).toBe(true);
  expect(Either.getOrThrow(normalizeWorkplace("all"))).toBe("1,2,3");
  expect(Either.getOrThrow(normalizeWorkplace("none"))).toBe("");

  for (const value of ["4", "remote", "1/2", "1,,2"]) expect(Either.isLeft(normalizeWorkplace(value))).toBe(true);
  const result = render({ interview_work_location: "1,3", interview_language: "English", interview_language_strict: "yes" });
  expect(result).toContain("Equally acceptable work arrangements: on-site, fully remote");
  expect(result).toContain("unstated arrangement remains unknown");
  expect(result.match(/- STRICT:/g)).toHaveLength(2);
  expect(render({ interview_language: "English", interview_language_strict: "no" })).toContain("- PREFER:");
  expect(render({ interview_language: "English" })).not.toContain("- STRICT:");
  expect(render({ interview_language: "English" })).not.toContain("- PREFER:");
  expect(hasMeaningfulContent(render({ interview_work_location: "none" }))).toBe(false);
  expect(hasMeaningfulContent(render({ interview_current_role: true }))).toBe(false);
  expect(render({ interview_experience_years: "Ten years" }, true)).not.toContain("Ten years");
  expect(Either.isLeft(decodeAnswers([]))).toBe(true);
});

test("narrative followups need a meaningful answer and valid nonboolean in-range index", () => {
  for (const index of [0, "0", " +0 ", "٠", "0_0", "\u0085+０\u0085"]) expect(render({ interview_current_role: "I plan routes.", interview_current_role_followup_index: index, interview_current_role_followup_answer: "More planning." })).toContain("Which parts do you want more of? More planning.");

  for (const index of [true, false, -1, 99, 0.5, "bad", null, "1.0"]) expect(render({ interview_current_role: "I plan routes.", interview_current_role_followup_index: index, interview_current_role_followup_answer: "UNIQUE FOLLOWUP" })).not.toContain("UNIQUE FOLLOWUP");
  expect(render({ interview_language: "English", interview_language_strict: "yes", interview_language_followup_index: 0, interview_language_followup_answer: "Norwegian too." })).toContain("- STRICT: Which languages can you use at work? Norwegian too.");
  expect(render({ interview_current_role: "TODO", interview_current_role_followup_index: 0, interview_current_role_followup_answer: "I plan routes." })).not.toContain("I plan routes.");
});

test("narrative template preserves resource headings, comments and order without inventing facts", () => {
  expect(fillTemplate(template, {})).toBe(template);
  expect(fillTemplate(template, { background: "I plan routes.", practical: "- PREFER: Daytime work." }).split("\n").filter((line) => line.startsWith("#"))).toEqual(sections);
  expect(checkNarrative(fillTemplate(template, { background: "I use Python." }), { requireMinimum: false })).toEqual([]);
  expect(checkNarrative(fillTemplate(template, { hard_limits: "- I prefer daytime work." }))).toContain("Start every hard-limit bullet with STRICT:.");

  for (const heading of sections) expect(checkNarrative(template.replace(heading + "\n", ""))).toContain(`Add the heading ${heading}.`);
});

test("narrative readiness ignores known filler but accepts meaningful legacy evidence", () => {
  for (const value of ["lorem ipsum", "Lorem ipsum dolor sit amet, consectetur adipiscing elit.", "[Add your experience here]", "[INSERT YOUR ANSWER HERE]", "```python\n```", "lorem ipsum lorem ipsum", "- PREFER: **Not stated.**", "١. TODO", "<placeholder>", "Facts not stated in this short form remain unknown. No examples were requested.", "# Profile\n- STRICT: TODO\n<!-- unfinished"]) {
    expect(hasMeaningfulContent(value)).toBe(false);
    expect(checkNarrative(value, { requireTemplate: false })).toContain("Add meaningful personal evidence.");
  }

  for (const value of ["I build reports with Python and SQL.", "[Python]", "I use lorem ipsum to mock pages", "```python\nI build reports with Python.\n```", "lorem ipsum\nI build reports with SQL.", "I enjoy solving unknown problems.", "-\uFEFFTODO", "## Hard limits\n- I cannot work nights."]) expect(checkNarrative(value, { requireTemplate: false })).toEqual([]);
  expect(checkNarrative("<!-- " + "word ".repeat(300))).toContain("Add at least 200 non-comment characters.");
});

test("narrative categories retain frozen letters/numbers and phone boundaries", () => {
  const unassigned = String.fromCodePoint(0x1c89);
  expect(hasMeaningfulContent(unassigned)).toBe(false);
  expect(hasMeaningfulContent(String.fromCodePoint(0x1cc00))).toBe(false);
  expect(checkNarrative(unassigned + "12345678", { requireTemplate: false, requireMinimum: false })).toContain("Remove phone numbers and personal ID numbers.");

  for (const old of ["ø", "中", "²", "Ⅻ"]) {
    expect(hasMeaningfulContent(old)).toBe(true);
    expect(checkNarrative(old + "12345678", { requireTemplate: false, requireMinimum: false })).not.toContain("Remove phone numbers and personal ID numbers.");
    expect(hasMeaningfulContent("```" + old)).toBe(false);
  }

  expect(hasMeaningfulContent("```python" + unassigned)).toBe(true);

  for (const zero of [0x660, 0xff10, 0x1d7ce, 0x1e4f0]) {
    const digit = String.fromCodePoint(zero);
    expect(hasMeaningfulContent(digit)).toBe(true);
    expect(hasMeaningfulContent(digit + ". TODO")).toBe(false);
    expect(checkNarrative(digit.repeat(8), { requireTemplate: false, requireMinimum: false })).toContain("Remove phone numbers and personal ID numbers.");
    expect(render({ interview_current_role: "I plan routes.", interview_current_role_followup_index: digit, interview_current_role_followup_answer: "UNIQUE FOLLOWUP" })).toContain("UNIQUE FOLLOWUP");
  }

  for (const zero of [0x10d40, 0x1e5f0]) {
    const digit = String.fromCodePoint(zero);
    expect(hasMeaningfulContent(digit)).toBe(false);
    expect(checkNarrative(digit.repeat(8), { requireTemplate: false, requireMinimum: false })).not.toContain("Remove phone numbers and personal ID numbers.");
    expect(render({ interview_current_role: "I plan routes.", interview_current_role_followup_index: digit, interview_current_role_followup_answer: "UNIQUE FOLLOWUP" })).not.toContain("UNIQUE FOLLOWUP");
  }
});

test("narrative fixed-prefix re.I behavior includes dotted/dotless I without broad grammar folding", () => {
  for (const prefix of ["STRICT", "STRİCT", "STRıCT", "ſtrİct", "PREFER"]) expect(hasMeaningfulContent(prefix + ":none")).toBe(false);
  expect(hasMeaningfulContent("STRİCTON:none")).toBe(true);
});

test("narrative privacy checks stay conservative, safe and active under minimum/template optouts", () => {
  for (const number of ["+47 12 34 56 78", "12345678", "12345678901", "(123) 456-7890"]) {
    const problems = checkNarrative("I plan routes. " + number, { requireTemplate: false, requireMinimum: false });
    expect(problems).toContain("Remove phone numbers and personal ID numbers.");
    expect(problems.join(" ")).not.toContain(number);
  }

  expect(checkNarrative("I plan routes. Updated 2026-11-12.", { requireTemplate: false })).toEqual([]);
  expect(checkNarrative("I plan routes." + " word".repeat(1500), { requireTemplate: false })).toContain("Reduce the profile to at most 1,500 words.");
});

const original = encode("## Who I am\nOld evidence\n## Examples\nKeep evidence");
const unsafeFragments = ["```\nx\n```", "## Who I am\nb", " ## Who I am\nx", "<!--\n## Who I am\nHidden\n-->", "## Who I am <!-- comment -->\nExisting", "<!-- unclosed", "<!-- nested <!-- comments --> -->", "Unknown\n=\nKeep", "Unknown\n==\nKeep", "Unknown\n-\nKeep", "Unknown\n--\nKeep", "<script>hidden</script>", "<div>hidden</div>", "I use <em>Python</em>.", "    ## Unknown\nCode", "\t## Unknown\nCode", "  Indented continuation.", "> ## Unknown\n> Quoted", "- ## Unknown", "1. ## Unknown", "- > Quoted", "- - Nested list.", "- ```", "1. ~~~", "I use Python.-->"];

test.each(unsafeFragments)("narrative section editing refuses unsafe original and replacement: %s", (fragment) => {
  const unsafe = encode("## Who I am\n" + fragment + "\n## Examples\nTail");
  expect(Either.isLeft(adjustableSections(unsafe))).toBe(true);
  expect(Either.isLeft(replaceSection(unsafe, "## Who I am", "I use Python."))).toBe(true);
  expect(Either.isLeft(replaceSection(original, "## Who I am", fragment))).toBe(true);
});

test.each(["\v", "\f", "\x1c", "\x1d", "\x1e", "\x85", "\u2028", "\u2029", "\r"])("narrative section editing refuses separator %j on both sides", (separator) => {
  expect(Either.isLeft(adjustableSections(encode(`Preamble${separator}## Who I am\nOld`)))).toBe(true);
  expect(Either.isLeft(replaceSection(original, "## Who I am", `Evidence${separator}Injected`))).toBe(true);
});

test.each(["\n", "\r\n"])("narrative section editing preserves Unicode and every byte outside bounded body with %j", (newline) => {
  const source = encode(["# Profile", "## Who I am", "<!--", "    Guidance <example>data</example>.", "-->", "I use blåbær 日本語.", "## Hard limits", "- STRICT: Stated salary.", "## Preferences", "- PREFER: Teamwork.", "## Unknown", "Keep all other bytes without a final newline"].join(newline));
  expect(Either.getOrThrow(adjustableSections(source))).toEqual(["## Who I am", "## Hard limits", "## Preferences"]);
  const result = Either.getOrThrow(replaceSection(source, "## Who I am", "I use Python.\r\nI explain SQL."));
  expect(decode(result)).toBe(["# Profile", "## Who I am", "I use Python.", "I explain SQL.", ""].join(newline) + decode(source).slice(decode(source).indexOf("## Hard limits")));
  fc.assert(fc.property(fc.string().filter((value) => !/[\r\n]/.test(value)), (suffix) => {
    const prefix = `# Profile${newline}## Who I am${newline}`;
    const tail = `${newline}## Examples${newline}Keep ${suffix.replace(/[^\p{L}\p{N} ]/gu, "")}`;
    const bytes = encode(prefix + "Old" + tail);
    expect(Either.getOrThrow(replaceSection(bytes, "## Who I am", "New ø"))).toEqual(encode(prefix + "New ø" + tail));
  }));
});

test("narrative section editing handles final heading/body/newline, invalid UTF8 and absent sections", () => {
  expect(decode(Either.getOrThrow(replaceSection(encode("## Examples"), "## Examples", "new")))).toBe("## Examples\nnew");
  expect(decode(Either.getOrThrow(replaceSection(encode("## Examples\r\nold\r\n"), "## Examples", "new")))).toBe("## Examples\r\nnew\r\n");
  expect(decode(Either.getOrThrow(replaceSection(original, "## Who I am", "")))).toBe("## Who I am\n## Examples\nKeep evidence");
  expect(Either.isLeft(adjustableSections(new Uint8Array([255])))).toBe(true);
  expect(Either.isLeft(replaceSection(original, "## Who I am", "\uD800"))).toBe(true);
  expect(Either.isLeft(replaceSection(original, "# Profile", "new"))).toBe(true);
  expect(Either.isLeft(replaceSection(original, "## Preferences", "new"))).toBe(true);
});

test("narrative resource Layer reads actual injected FileSystem resources without writes", async () => {
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const temporary = yield* fs.makeTempDirectoryScoped();
    const suggestions = `${temporary}/suggestions.toml`;
    yield* fs.writeFileString(suggestions, '[mode]\nvalue = "active"\nreason = "Explicit request"\n');
    const paths = { template: "skills/pulse-interview/profile-template.md", questions: "skills/pulse-interview/questions.toml", catalog: "config/occupation_categories.toml", suggestions };
    const resources = yield* NarrativeResources.pipe(Effect.provide(narrativeResourcesLayer(paths)));
    expect(yield* resources.template).toBe(template);
    expect(yield* resources.questions()).toHaveLength(28);
    expect(yield* resources.questions(true)).toHaveLength(9);
    expect((yield* resources.catalog).length).toBeGreaterThan(0);
    expect((yield* resources.suggestions).mode?.value).toBe("active");
    expect(yield* fs.readFileString(suggestions)).toBe('[mode]\nvalue = "active"\nreason = "Explicit request"\n');
    yield* fs.writeFile(suggestions, new Uint8Array([255]));
    expect(Either.isLeft(yield* Effect.either(resources.suggestions))).toBe(true);
    yield* fs.writeFileString(suggestions, "unknown = true");
    expect(Either.isLeft(yield* Effect.either(resources.suggestions))).toBe(true);
    yield* fs.remove(suggestions);

    return yield* Effect.either(resources.suggestions);
  })).pipe(Effect.provide(BunFileSystem.layer)));

  expect(Either.isLeft(result)).toBe(true);
});
