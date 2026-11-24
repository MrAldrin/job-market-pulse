import { readable, writable } from 'svelte/store';
import { parseJobFilters, type JobFilters } from './jobfilter';

// A fresh entry or reload has no known in-app predecessor. Fall back to Jobs.
export const canGoBackInApp = writable(false);

export type Route =
  | { page: 'home' }
  | { page: 'jobs'; filters?: JobFilters }
  | { page: 'job'; id: string }
  | { page: 'market' }
  | { page: 'salary' }
  | { page: 'settings' }
  | { page: 'run' }
  | { page: 'about' }
  | { page: 'notfound' };

export function parseRoute(hash: string): Route {
  if (hash.startsWith('#/jobs?')) {
    return {
      page: 'jobs',
      filters: parseJobFilters(hash.slice('#/jobs?'.length)),
    };
  }

  switch (hash) {
    case '':
    case '#':
    case '#/':
      return { page: 'home' };
    case '#/jobs':
      return { page: 'jobs' };
    case '#/market':
      return { page: 'market' };
    case '#/salary':
      return { page: 'salary' };
    case '#/run':
      return { page: 'run' };
    case '#/settings':
      return { page: 'settings' };
    case '#/about':
      return { page: 'about' };
  }

  const job = /^#\/jobs\/([^/?#]+)$/.exec(hash);

  if (job?.[1]) {
    try {
      return { page: 'job', id: decodeURIComponent(job[1]) };
    } catch {
      // A malformed URL must show Not found, not break the shell.
    }
  }

  return { page: 'notfound' };
}

/** Listen only while subscribed, including after a later remount. */
export const currentRoute = readable<Route>({ page: 'home' }, (set) => {
  if (typeof window === 'undefined') return;

  const update = (event?: HashChangeEvent) => {
    if (event?.oldURL) {
      canGoBackInApp.set(
        parseRoute(new URL(event.oldURL).hash).page !== 'notfound',
      );
    } else {
      canGoBackInApp.set(false);
    }

    set(parseRoute(window.location.hash));
  };

  update();
  window.addEventListener('hashchange', update);

  return () => window.removeEventListener('hashchange', update);
});
