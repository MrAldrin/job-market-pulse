import type { SnapshotDocument } from "../contracts/snapshot.ts";
import { consecutiveMonths } from "./period-adjacency.ts";

export const projectSalary = (snapshot: SnapshotDocument) => {
  const salary = snapshot.salary;

  if (salary === null) return { state: "unavailable" as const };

  const jobs = new Map(snapshot.jobs.map((job) => [job.id, job]));

  const ads = salary.ads.map((fact) => {
    const job = jobs.get(fact.job_id);

    return { fact, jobLink: job ? { id: job.id, sourceUrl: job.url } : null };
  });

  const samples = new Map<string, number[]>();

  for (const { fact } of ads) {
    const value = fact.yearly_midpoint;

    if ((fact.form !== "range" && fact.form !== "single") || fact.low === null || fact.period === null || fact.outside_plausible_range
      || value === null || value < 150_000 || value > 3_000_000) continue;
    const values = samples.get(fact.month) ?? [];

    values.push(value);
    samples.set(fact.month, values);
  }

  const monthly = salary.monthly.map((month, index) => {
    const previous = salary.monthly[index - 1];

    const hidden = month.numeric < 5;
    const median_yearly = hidden ? null : month.median_yearly;
    const values = samples.get(month.month) ?? [];
    const ordered = values.length === month.numeric && median_yearly !== null ? values.toSorted((a, b) => a - b) : [];
    const low = ordered[0];
    const high = ordered.at(-1);
    const middle = (ordered.length - 1) / 2;
    const lowerMiddle = ordered[Math.floor(middle)];
    const upperMiddle = ordered[Math.ceil(middle)];

    // Match both the saved count and median before deriving new statistics.
    const stats = low !== undefined && high !== undefined && lowerMiddle !== undefined && upperMiddle !== undefined
      && (lowerMiddle + upperMiddle) / 2 === median_yearly
      ? { low, high, mean: ordered.reduce((total, value) => total + value, 0) / ordered.length } : null;

    return {
      ...month, median_yearly, hidden, stats,
      connectsToPrevious: previous !== undefined && previous.numeric >= 5 && previous.median_yearly !== null
        && median_yearly !== null && consecutiveMonths(previous.month, month.month),
    };
  });

  return {
    state: ads.length === 0 && monthly.length === 0 && salary.undated === 0 ? "empty" as const : "saved" as const,
    ads, monthly, undated: salary.undated,
  };
};
