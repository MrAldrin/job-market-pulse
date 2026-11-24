import { FIT_ORDER, type Fit, type Job, type Snapshot } from './snapshot';

export type JobView = 'closed' | 'run-reviewed' | 'run-recommended';

export interface JobFilters {
  view?: JobView;
  fits: Set<Fit>;
  showClosed: boolean;
  savedOnly: boolean;
  query: string;
  sort: 'fit' | 'newest' | 'employer';
}

export function defaultJobFilters(): JobFilters {
  return {
    fits: new Set(FIT_ORDER.filter((fit) => fit !== 'poor')),
    showClosed: false,
    savedOnly: false,
    query: '',
    sort: 'fit',
  };
}

function newest(a: Job, b: Job): number {
  const left = a.first_found_at ? Date.parse(a.first_found_at) : NaN;
  const right = b.first_found_at ? Date.parse(b.first_found_at) : NaN;

  if (!Number.isFinite(left)) return Number.isFinite(right) ? 1 : 0;

  if (!Number.isFinite(right)) return -1;

  return right - left;
}

export function filterJobs(
  jobs: readonly Job[],
  f: JobFilters,
  savedIds?: ReadonlySet<string>,
): Job[] {
  const query = f.query.trim().toLocaleLowerCase('nb');

  return jobs
    .filter(
      (job) =>
        (f.showClosed || job.status !== 'closed') &&
        (!f.savedOnly || !savedIds || savedIds.has(job.id)) &&
        (!f.fits.size || f.fits.has(job.assessment.fit)) &&
        (!query ||
          job.title.toLocaleLowerCase('nb').includes(query) ||
          job.employer.toLocaleLowerCase('nb').includes(query)),
    )
    .toSorted((a, b) => {
      let order: number;

      if (f.sort === 'fit') {
        order = FIT_ORDER.indexOf(a.assessment.fit) -
          FIT_ORDER.indexOf(b.assessment.fit) || newest(a, b);
      } else if (f.sort === 'newest') {
        order = newest(a, b);
      } else {
        order = a.employer.localeCompare(b.employer, 'nb');
      }

      return (
        order ||
        a.title.localeCompare(b.title, 'nb') ||
        a.id.localeCompare(b.id)
      );
    });
}

export function jobsInView(snapshot: Snapshot, view: JobView | undefined): readonly Job[] {
  if (view === 'closed') return snapshot.jobs.filter((job) => job.status === 'closed');

  if (!view) return snapshot.jobs;
  const ids = new Set('run_funnel' in snapshot ? snapshot.run_funnel?.pool?.listed_review_ids : []);
  const recommended = new Set(snapshot.shortlist.job_ids);

  return snapshot.jobs.filter((job) => ids.has(job.id) && (view !== 'run-recommended' || recommended.has(job.id)));
}

export function parseJobFilters(search: string): JobFilters {
  const params = new URLSearchParams(search);
  const defaults = defaultJobFilters();
  const rawFit = params.get('fit');

  const fits =
    rawFit === null
      ? defaults.fits
      : new Set(
          rawFit
            .split(',')
            .filter((fit): fit is Fit => FIT_ORDER.some((known) => known === fit)),
        );

  const sort = params.get('sort');
  const view = params.get('view');

  const filters: JobFilters = {
    fits,
    showClosed: view === 'closed' || params.get('closed') === '1',
    savedOnly: params.get('saved') === '1',
    query: params.get('q') ?? '',
    sort: sort === 'newest' || sort === 'employer' ? sort : 'fit',
  };

  if (view === 'closed' || view === 'run-reviewed' || view === 'run-recommended') filters.view = view;

  return filters;
}

export function jobsHash(filters: JobFilters): string {
  const params = new URLSearchParams();
  // An explicit empty fit value means all fits, unlike the initial defaults.
  params.set('fit', FIT_ORDER.filter((fit) => filters.fits.has(fit)).join(','));

  if (filters.view) params.set('view', filters.view);

  if (filters.showClosed) params.set('closed', '1');

  if (filters.savedOnly) params.set('saved', '1');

  if (filters.query) params.set('q', filters.query);

  if (filters.sort !== 'fit') params.set('sort', filters.sort);

  return '#/jobs?' + params.toString();
}
