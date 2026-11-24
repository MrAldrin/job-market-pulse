import { Predicate } from "effect";
import type { SnapshotDocument } from "../../contracts/snapshot.ts";
import { PythonFloat, pythonFloat, pythonJson } from "../shared/python-json.ts";

// SAFETY: pinned Bun supports rawJSON; TypeScript's standard JSON interface omits it.
const nativeJson = JSON as JSON & { readonly rawJSON: (text: string) => object };
const floatFields = new Set(["low", "high", "yearly_midpoint", "median_yearly"]);
const floating = (value: number | null) => value === null ? null : new PythonFloat(value);

export const snapshotPrettyJson = (document: SnapshotDocument): string => pythonJson({
  ...document,
  salary: document.salary === null ? null : {
    ...document.salary,
    ads: document.salary.ads.map((ad) => ({ ...ad, low: floating(ad.low), high: floating(ad.high), yearly_midpoint: floating(ad.yearly_midpoint) })),
    monthly: document.salary.monthly.map((month) => ({ ...month, median_yearly: floating(month.median_yearly) })),
  },
}, false, true);

export const snapshotJsonBytes = (document: SnapshotDocument): Uint8Array => {
  // Preserve the retained compact upload encoding, including salary-ad field order.
  const salary = document.salary === null ? null : {
    ...document.salary,
    ads: document.salary.ads.map(({ job_id, yearly_midpoint, outside_plausible_range, ...fields }) => ({
      ...fields, job_id, yearly_midpoint, outside_plausible_range,
    })),
  };

  return new TextEncoder().encode(JSON.stringify({ ...document, salary }, (key, value) =>
    floatFields.has(key) && Predicate.isNumber(value) ? nativeJson.rawJSON(pythonFloat(value)) : value));
};
