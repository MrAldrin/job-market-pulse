import { Either } from "effect";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeSnapshotBytes } from "../../src/lib/contracts/snapshot.ts";
import { employerCandidates, feedbackEvidence, likedTitleSample, poorTitleSample, preferredProposal, profileProposal, removalCandidates, selectCandidate, titleProposal } from "../../src/lib/server/calibrate/settings-suggestion-rules.ts";

const fixture = Either.getOrThrow(decodeSnapshotBytes(readFileSync("contracts/fixtures/snapshot.example.json")));
const poor = fixture.jobs.find((job) => job.assessment.fit === "poor");

if (!poor) throw new Error("Expected a poor-fit fixture job");

const revision = "a".repeat(64);
const first = { ...poor, id: "first", title: "Sales role — example A" };
const second = { ...poor, id: "second", title: "Sales role — example B" };
const titleReply = JSON.stringify({ reason: "Repeated poor fit", term: "sales role" });
const termBase = { revision, excluded_title_terms: ["carpenter"] };

const checkTitle = (jobs = [first, second], base = termBase) =>
  Either.getOrThrow(titleProposal(titleReply, base, jobs, poorTitleSample(jobs)));

const filters = { ...termBase, location: { home_postcode: '', radius_km: 27, place: null }, excluded_municipalities: ["Invented town"], excluded_employers: ["Unknown shop"], allowed_occupation_categories: ["IT"] };
const sales = [first, second].map((job) => ({ ...job, employer: "Invented Sales" }));

describe("settings suggestion evidence", () => {
  it("requires repeated reviewed poor fit and no counterexample for an employer", () => {
    const jobs = [sales[0]!, { ...sales[1]!, employer: " INVENTED SALES " }];
    const candidates = employerCandidates(filters, jobs, new Map());
    expect(candidates.map(({ change }) => change)).toEqual([{ kind: "filters", revision, values: {
      excluded_municipalities: filters.excluded_municipalities, allowed_occupation_categories: filters.allowed_occupation_categories,
      excluded_employers: ["Unknown shop", "Invented Sales"],
    } }]);
    expect(employerCandidates(filters, jobs, null)).toEqual([]);
    expect(employerCandidates(filters, jobs.slice(0, 1), new Map())).toEqual([]);
    expect(employerCandidates(filters, jobs, new Map([[first.id, "up"]]))).toEqual([]);
    expect(employerCandidates({ ...filters, excluded_employers: ["invented SALES"] }, jobs, new Map())).toEqual([]);
    const unreviewed = { ...jobs[0]!, id: "counterexample", assessment: { ...first.assessment, ad_text_reviewed: false } };
    expect(employerCandidates(filters, [...jobs, unreviewed], new Map())).toEqual([]);
    expect(Either.getOrThrow(selectCandidate('{"candidate":0}', candidates))).toEqual(candidates[0]);
    expect(Either.isLeft(selectCandidate('{"candidate":1}', candidates))).toBe(true);
    expect(Either.isLeft(selectCandidate('{"candidate":0,"change":"invented"}', candidates))).toBe(true);
  });

  it("accepts only a new literal preferred term supported by a sampled liked title", () => {
    const sent = likedTitleSample([first, { ...second, title: "Research roles" }], new Map([[first.id, "up"], [second.id, "down"]]));
    const base = { revision, preferred_terms: ["scientist"] };
    const propose = (term: string) => Either.getOrThrow(preferredProposal(JSON.stringify({ term, reason: "Liked title" }), base, sent));
    expect(propose("sales role")?.change).toEqual({ kind: "judge", revision, values: ["scientist", "sales role"] });
    expect(propose("research")).toBeNull();
    expect(propose("sales.*")).toBeNull();
    expect(Either.getOrThrow(preferredProposal(titleReply, { ...base, preferred_terms: ["Sales"] }, sent))).toBeNull();
  });

  it("replays current literal exclusions only against liked saved jobs", () => {
    const base = { ...filters, excluded_title_terms: ["carpenter", "sales role", "sale"], excluded_employers: ["Unknown shop", "INVENTED SALES"] };
    expect(removalCandidates(base, sales, new Map())).toEqual([]);
    const proposals = removalCandidates(base, sales, new Map([[first.id, "up"], [second.id, "down"]]));
    expect(proposals.map(({ rule }) => rule)).toEqual(["sales role", "INVENTED SALES"]);
    expect(proposals.map(({ change }) => change.values)).toEqual([["carpenter", "sale"], {
      excluded_municipalities: base.excluded_municipalities, excluded_employers: ["Unknown shop"], allowed_occupation_categories: base.allowed_occupation_categories,
    }]);
    expect(proposals.every(({ reason }) => reason.includes("does not show whether"))).toBe(true);
  });
  it("appends only the supported literal term to the exact title list", () => {
    const result = checkTitle();
    expect(result?.change).toEqual({ revision, kind: "excluded_title_terms", values: ["carpenter", "sales role"] });
    expect(result?.evidence.map(({ job_id }) => job_id)).toEqual(["first", "second"]);
  });

  it("requires repeated new evidence and checks beyond the model sample", () => {
    const unsampled = Array.from({ length: 25 }, (_, index) => ({ ...first, id: `filler-${index}`, title: `Other role ${index}` }));
    const unknown = { ...first, id: "unknown", assessment: { ...first.assessment, fit: "unknown", ad_text_reviewed: false } } as const;
    expect(checkTitle([first])).toBeNull();
    expect(checkTitle([first, { ...second, title: "Presales role" }])).toBeNull();
    expect(checkTitle([first, second], { revision, excluded_title_terms: ["sales"] })).toBeNull();
    expect(checkTitle([first, second, ...unsampled, unknown])).toBeNull();
  });

  it("binds the profile edit to real supplied reaction IDs", () => {
    const base = { revision, text: "Builds wood tools.\n" };
    const nextText = `${base.text}Prefers small tool shops.\n`;
    const sent = feedbackEvidence([first, second], new Map([[first.id, "up"], [second.id, "down"], ["absent", "up"]]));
    const reply = (job_ids: readonly string[]) => JSON.stringify({ reason: "A preference in the titles", text: nextText, job_ids });
    const valid = Either.getOrThrow(profileProposal(reply([first.id, second.id]), base, sent));
    expect(valid?.change).toEqual({ revision, kind: "narrative", values: nextText });
    expect(valid?.evidence.map(({ signal }) => signal)).toEqual(["liked", "disliked"]);
    expect(Either.isLeft(profileProposal(reply(["absent"]), base, sent))).toBe(true);
    expect(Either.isLeft(profileProposal(reply([first.id, first.id]), base, sent))).toBe(true);
  });

  it("accepts an explicit no-change reply and rejects malformed or excess data", () => {
    const base = { revision, text: "Builds wood tools.\n" };
    const sent = feedbackEvidence([first], new Map([[first.id, "up"]]));
    expect(Either.getOrThrow(profileProposal("null\n", base, sent))).toBeNull();
    expect(Either.getOrThrow(titleProposal("null", termBase, [first, second], [first, second]))).toBeNull();
    expect(Either.isLeft(profileProposal('{"reason":"fake","reason":"duplicate"}', base, sent))).toBe(true);
    expect(Either.isLeft(titleProposal('{"reason":"fake","term":"sales","apply":true}', termBase, [first, second], [first, second]))).toBe(true);
  });
});
