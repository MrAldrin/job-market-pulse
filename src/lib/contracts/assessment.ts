import { Schema } from "effect";
import { ReviewAssessment } from "./fit-review.ts";
import { boundedText, header } from "./support.ts";

// Offline values only. This does not admit a review against current Source facts.
export const AssessmentRow = Schema.Struct({ ...ReviewAssessment.fields, id: boundedText(), version: boundedText() }).pipe(
  Schema.filter((row) => {
    if ((row.fit === "strong" || row.fit === "exceptional") && (!row.ad_text_reviewed || row.evidence.length === 0)) return false;

    return row.fit !== "exceptional" || (row.uncertainties.length === 0 && row.hard_constraints === "pass");
  }),
);

export const AssessmentBatch = Schema.Struct({ ...header("pulse.assessment", 1), assessments: Schema.Array(AssessmentRow).pipe(
  Schema.maxItems(120), Schema.filter((rows) => new Set(rows.map((row) => row.id)).size === rows.length),
) });

export type AssessmentBatch = typeof AssessmentBatch.Type;
