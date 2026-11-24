import { Either, Option, Predicate, Schema } from "effect";
import type { CandidateManifest } from "../../contracts/filter.ts";
import type { SourceListing } from "../../contracts/source-review.ts";
import type { PersonalInputs } from "../profile/service.ts";
import { parseJsonInput, JsonInput } from "../shared/json-input.ts";
import { codepointOrder } from "../shared/python-json.ts";
import { collapseWhitespace } from "../shared/text.ts";
import { verifyWorkplaceEvidence } from "../shared/workplace-fingerprint.ts";
import { assess } from "./assessment.ts";
import { admissionAllowed, type OccupationPair } from "./candidate-filters.ts";
import { assessLocation, normalizeName, point, type AreaExtent, type GeoAssessment, type Point } from "./geography.ts";
import { personalScreen, type ScreenContext } from "./screen-context.ts";
import { sourcePoint } from "./source-policy.ts";

export type FilterSourceListing = Pick<SourceListing,
  "row" | "hasLocationPoints" | "locationEvidence" | "detailEvidence" | "versionChanged" | "geographyEvidenceDigest"
>;

export type AdmissionCheck = (content: Readonly<Record<string, JsonInput>>, listing: FilterSourceListing) => GeoAssessment | null;

const isSourceObject = Schema.is(Schema.Record({ key: Schema.String, value: JsonInput }));
const text = (value: JsonInput | undefined): string => Predicate.isString(value) ? value : "";
const same = (left: readonly string[], right: readonly string[]): boolean => left.length === right.length && left.every((item, index) => item === right[index]);

export const occupationPairsFromContent = (content: Readonly<Record<string, JsonInput>>): readonly OccupationPair[] | null => {
  const categories = content.occupationCategories ?? [];

  if (!Array.isArray(categories)) return null;
  const pairs = new Map<string, OccupationPair>();

  for (const item of categories) {
    if (!isSourceObject(item)) return null;

    if ([item.level1, item.level2].some((value) => value !== null && value !== undefined && !Predicate.isString(value))) return null;
    const left = collapseWhitespace(text(item.level1));
    const right = collapseWhitespace(text(item.level2));

    if (left) pairs.set(JSON.stringify([left, right]), [left, right]);
  }

  return [...pairs.values()].sort((a, b) => codepointOrder(a[0], b[0]) || codepointOrder(a[1], b[1]));
};

// Source owns detail identity/status, updated/expiry clocks, source-version CAS,
// text and manifested digest binding. This callback rechecks only current
// Filter admission from the same typed Profile and Source snapshot. It performs
// no SQL, file, clock, network or legacy settings access.
export const makeCurrentAdmission = (
  settings: PersonalInputs, manifest: CandidateManifest | null, areas: ReadonlyMap<string, AreaExtent>, override?: ScreenContext,
): AdmissionCheck | null => {
  if (manifest === null) return null;
  const screen = personalScreen(override);
  const prefs = settings.preferences;
  const fit = manifest.fit_preferences;

  const valid = manifest.preferences_fingerprint === settings.preference_fingerprint && manifest.rules_fingerprint === screen.rules_fingerprint
    && same(fit.preferred_terms, prefs.preferred_terms) && same(fit.allowed_occupation_categories, prefs.allowed_occupation_categories)
    && same(fit.excluded_title_terms, prefs.excluded_title_terms) && same(fit.excluded_employers, prefs.excluded_employers)
    && same(fit.excluded_municipalities, prefs.excluded_municipalities) && fit.hard_limits.geography_radius_km === prefs.radius_km
    && fit.hard_limits.geography_already_applied === true;

  if (!valid) return () => null;
  const candidates = new Map(manifest.candidates.map((candidate) => [candidate.id, candidate]));

  return (content, listing) => {
    const uuid = text(listing.row.uuid);
    const sourceVersion = text(listing.row.changed);
    const candidate = candidates.get(uuid);
    const pairs = occupationPairsFromContent(content);

    if (candidate === undefined || candidate.version !== sourceVersion || candidate.geography !== "inside" || pairs === null) return null;

    if (!Predicate.isString(content.title) || !isSourceObject(content.employer) || !Predicate.isString(content.employer.name) || !Array.isArray(content.workLocations)) return null;
    const labels = new Set<string>();

    for (const location of content.workLocations) {
      if (!isSourceObject(location)) return null;
      const label = text(location.municipal) || text(location.city);

      if (label) labels.add(label);
    }

    const locations = [...labels].sort(codepointOrder);
    const assessment = assess(content.title, content.employer.name, locations, [], [], prefs, screen.excludeTitle);

    if (assessment.excluded_reason !== null || !admissionAllowed(content.title, pairs, prefs)) return null;
    const origin = prefs.origin_source ? point(prefs.origin_latitude, prefs.origin_longitude) : null;

    if (origin === null) return null;
    const points: Point[] = [];

    if (listing.hasLocationPoints !== false) {
      const evidence = listing.locationEvidence;

      if (evidence === null || !Predicate.isString(evidence.points) || !Predicate.isString(evidence.provenance) || (evidence.incomplete !== false && evidence.incomplete !== 0)) return null;

      const input = {
        uuid, sourceVersion, versionChanged: listing.versionChanged, pointsJson: evidence.points,
        provenance: evidence.provenance, incomplete: evidence.incomplete, currentDetailContent: content,
      };

      const verified = verifyWorkplaceEvidence(listing.detailEvidence === null ? input : { ...input, currentDetailEvidence: listing.detailEvidence });

      if (Option.isNone(verified) || verified.value.geography_digest !== listing.geographyEvidenceDigest) return null;
      const raw = parseJsonInput(evidence.points);

      if (Either.isLeft(raw) || !Array.isArray(raw.right)) return null;

      for (const value of raw.right) {
        const checked = sourcePoint(value);

        if (checked === null) return null;
        points.push(checked);
      }
    }

    const geography = assessLocation(origin, points, locations, Math.min(40, prefs.radius_km), false, areas, normalizeName);

    return geography.status === "inside" ? geography : null;
  };
};
