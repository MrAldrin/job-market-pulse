import type { SnapshotDocument } from './contracts/snapshot';

export type Snapshot = SnapshotDocument;

export type Job = Snapshot['jobs'][number];

export type Fit = Job['assessment']['fit'];

export const FIT_ORDER: Fit[] = [
  'exceptional',
  'strong',
  'possible',
  'poor',
  'unknown',
];

export function jobById(snapshot: Snapshot, id: string): Job | undefined {
  return snapshot.jobs.find((job) => job.id === id);
}

/** Keep the contract's selection order; do not select or rank jobs here. */
export function shortlistJobs(snapshot: Snapshot): Job[] {
  const jobs = new Map(snapshot.jobs.map((job) => [job.id, job]));

  return snapshot.shortlist.job_ids.flatMap((id) => {
    const job = jobs.get(id);

    return job ? [job] : [];
  });
}
