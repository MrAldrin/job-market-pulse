import type { SnapshotV5 } from "../../src/lib/contracts/snapshot.ts";
import type { SnapshotPersonalInputs, SnapshotSettings } from "../../src/lib/contracts/snapshot-settings.ts";

export const examplePersonalInputs: SnapshotPersonalInputs = {
  home_location: {
    label: "Invented private origin", home_postcode: "9917", area_postcode: "9918",
    origin: { latitude: 60, longitude: 10.5, source: "invented lookup" },
  },
  narrative: "Invented comparison profile\nWorks with <b>invented systems</b>.",
};

export const exampleSettings: SnapshotSettings = {
  policy: { market_only: false, freshness_max_age_hours: 36 },
  filters: {
    radius_km: 32.5, preferred_municipalities: ["Invented town"], nearby_municipalities: null, excluded_municipalities: [],
    allowed_occupation_categories: ["IT"], excluded_title_terms: ["carpenter", "<b>invented title</b>"],
    excluded_employers: ["Invented employer"], preferred_terms: ["software"],
  },
  title_screen: { academic: ["invented professor"], business_development: [], sales: [], tech_words: ["SQL"] },
  sources: { name: "nav", excludes_finn: true },
  review: {
    screen: { harness: "pi", provider: "synthetic", model: "quick-model", effort: "low", batch_size: 20 },
    judge: { harness: "claude-code", provider: "anthropic", model: "invented-model", effort: "high", batch_size: 4 },
    rejudge: { harness: "pi", provider: "synthetic", model: "repeat-model", effort: "medium", batch_size: 3 },
    calibrate: { harness: "pi", provider: "synthetic", model: "calibration-model", effort: "minimal", batch_size: 5 },
  },
  schedule: { kind: "every_n_weeks", timezone: "Europe/Oslo", interval: 2, weekday: 4, day_of_month: null, time: "09:15", anchor: "2026-11-13" },
};

// A feed change is not a unique ad. The pool also includes ads read in earlier runs.
export const exampleRunFunnel: SnapshotV5["run_funnel"] = {
  nav_events: 3,
  pool: {
    filters: { pool: 70, area: 16, exclusions: 5, occupation: 9, other: 0 },
    screen: { out: 26, undecided: 6, advanced: 8 },
    judge: { unfinished: 4, fits: { exceptional: 1, strong: 1, possible: 1, unknown: 0, poor: 1 } },
    waiting: 7, failed: 2,
    listed_review_ids: [1, 3, 7, 10].map((n) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`),
  },
};
