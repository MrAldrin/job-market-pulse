import type { SnapshotRejudge } from "../../contracts/snapshot.ts";
import type { MarketAd, SavedMarketSnapshot } from "../../contracts/market.ts";
import type { RunPoolFacts } from "../judge/dashboard.ts";
import type { SalaryRow } from "../market/salary-view.ts";
import type { Taxonomy } from "../market/taxonomy.ts";
import type { SavedCandidate, SelectMode } from "../select/shortlist-select.ts";

// Internal saved-state projection supplied by the owning Judge adapter.
export interface SnapshotCandidate extends SavedCandidate {
  readonly source_version: string;
  readonly locations: readonly string[];
  readonly url: string;
  readonly full_review_result_id: string | null;
  readonly older_review?: boolean;
  readonly rejudge?: typeof SnapshotRejudge.Type & { readonly reviewed_at: string };
  readonly full_review: (NonNullable<SavedCandidate["full_review"]> & {
    readonly fit: string; readonly reason: string; readonly evidence: readonly string[];
    readonly uncertainties: readonly string[]; readonly hard_constraints: string;
    readonly ad_text_reviewed: boolean;
  }) | null;
}

export interface SnapshotInputs {
  readonly now: string;
  readonly profile: { readonly id: string; readonly mode: SelectMode };
  readonly funnel: { readonly verified: boolean; readonly listingIds: ReadonlySet<string> };
  readonly judge: {
    readonly checked_at: string;
    readonly eligible_count: number; readonly pending_count: number;
    readonly screened_out_count: number; readonly failed_count: number;
    readonly ranked: readonly SnapshotCandidate[]; readonly closed: readonly SnapshotCandidate[];
    readonly runPool?: RunPoolFacts | null;
    readonly distances?: ReadonlyMap<string, number>;
    readonly firstFound: Readonly<Record<string, string>>;
  };
  readonly market: {
    readonly snapshots: readonly SavedMarketSnapshot[]; readonly taxonomy: Taxonomy;
    readonly ads: readonly MarketAd[]; readonly salaries: readonly SalaryRow[];
  };
}
