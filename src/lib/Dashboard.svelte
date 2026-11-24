<script lang="ts">
  import { asset } from '$app/paths';
  import { onMount, tick } from 'svelte';
  import './dashboard.css';
  import ErrorState from './components/ErrorState.svelte';
  import LocalRun from './components/LocalRun.svelte';
  import { relativeTime } from './format';
  import { FeedbackStore } from './feedbackStore.svelte';
  import { currentRoute, parseRoute, type Route } from './router';
  import type { MarketRecording } from './contracts/pipeline-progress';
  import type { Snapshot } from './snapshot';
  import Home from './pages/Home.svelte';
  import Jobs from './pages/Jobs.svelte';
  import JobPage from './pages/JobPage.svelte';
  import Market from './pages/Market.svelte';
  import Salary from './pages/Salary.svelte';
  import Settings from './pages/Settings.svelte';
  import About from './pages/About.svelte';
  import NotFound from './pages/NotFound.svelte';

  let { snapshot = null, error = 'No snapshot yet', reload, canGiveFeedback = false, canEditSettings = false, canRunRefresh = false }: {
    snapshot?: Snapshot | null;
    error?: string | null;
    reload?: () => Promise<void>;
    canGiveFeedback?: boolean;
    canEditSettings?: boolean;
    canRunRefresh?: boolean;
  } = $props();

  type LoadState =
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'empty' }
    | { status: 'ready'; snapshot: Snapshot };

  const pages: Record<Route['page'], { name: string }> =
    {
      home: { name: 'Home' },
      jobs: { name: 'Jobs' },
      job: { name: 'Job detail' },
      market: { name: 'Market' },
      salary: { name: 'Salary' },
      settings: { name: 'Settings' },
      run: { name: 'Run' },
      about: { name: 'About' },
      notfound: { name: 'Not found' },
    };

  const navigation = [
    { page: 'home', label: 'Home', href: '#/' },
    { page: 'jobs', label: 'Jobs', href: '#/jobs' },
    { page: 'market', label: 'Market', href: '#/market' },
    { page: 'salary', label: 'Salary', href: '#/salary' },
    { page: 'settings', label: 'Settings', href: '#/settings' },
    { page: 'about', label: 'About', href: '#/about' },
    { page: 'run', label: 'Run', href: '#/run' },
  ];

  // The server cannot see the hash. Adopt it after hydration.
  let route = $state<Route>(parseRoute(''));

  let refreshing = $state(false);

  const loadState = $derived<LoadState>(refreshing
    ? { status: 'loading' }
    : snapshot ? { status: 'ready', snapshot }
    : error ? { status: 'error', message: error } : { status: 'empty' });

  let now = $state(new Date());
  let marketRecording = $state<MarketRecording>();
  const feedback = $derived(canGiveFeedback ? new FeedbackStore('/app/') : undefined);
  let content: HTMLElement;
  let disposed = false;
  const page = $derived(pages[route.page === 'run' && !canRunRefresh ? 'notfound' : route.page]);
  const activePage = $derived(route.page === 'job' ? 'jobs' : route.page);

  async function refresh(showLoading = true): Promise<void> {
    if (!reload) return;

    if (showLoading) refreshing = true;

    try {
      await reload();

      if (!disposed) {
        now = new Date();

        if (snapshot) void feedback?.load();
      }
    } finally {
      if (!disposed && showLoading) refreshing = false;
    }
  }

  const routeKey = (value: Route) =>
    value.page === 'job' ? `job:${value.id}` : value.page;

  onMount(() => {
    const positions: Record<string, number> = {};
    const restoration = history.scrollRestoration;
    history.scrollRestoration = 'manual';

    const unsubscribe = currentRoute.subscribe((next) => {
      const changed =
        next.page !== route.page ||
        (next.page === 'job' && route.page === 'job' && next.id !== route.id);

      if (changed) positions[routeKey(route)] = window.scrollY;
      route = next;

      if (changed)
        void tick().then(() => {
          if (!disposed) {
            content?.focus({ preventScroll: true });
            window.scrollTo(0, positions[routeKey(next)] ?? 0);
          }
        });
    });

    if (snapshot) void feedback?.load();

    return () => {
      disposed = true;
      history.scrollRestoration = restoration;
      unsubscribe();
    };
  });
</script>

<svelte:head>
  {#if route.page !== 'job'}<title>{page.name} · Job Market Pulse</title>{/if}
</svelte:head>

<a
  href="#content"
  class="sr-only fixed top-2 left-2 z-10 rounded-md bg-primary p-3 text-primary-foreground focus:not-sr-only"
  onclick={(event) => {
    event.preventDefault();
    content?.focus();
  }}>Skip to content</a
>

<header class="border-b">
  <div class="mx-auto flex max-w-6xl flex-wrap items-center gap-4 p-4">
    <a class="flex shrink-0 items-center gap-2 text-lg font-semibold" href="#/"><img src={asset('favicon.svg')} alt="" class="size-7" />Job Market Pulse</a>
    <nav
      aria-label="Main navigation"
      class="flex flex-wrap gap-1 max-[599px]:w-full"
    >
      {#each navigation.filter((link) => link.page !== 'run' || canRunRefresh) as link (link.page)}
        <a
          href={link.href}
          aria-current={activePage === link.page ? 'page' : undefined}
          class="rounded-md px-3 py-2 text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring aria-[current=page]:bg-secondary aria-[current=page]:font-semibold"
          >{link.label}</a
        >
      {/each}
    </nav>
  </div>
</header>

{#if loadState.status === 'ready'}
  <p
    role="status"
    class="mx-auto max-w-6xl px-4 pt-4 text-sm text-muted-foreground"
  >
    Updated {relativeTime(loadState.snapshot.generated_at, now)} · {loadState
      .snapshot.counts.reviewed} jobs reviewed
  </p>
{/if}

<main
  id="content"
  tabindex="-1"
  bind:this={content}
  class="mx-auto max-w-6xl p-4 focus:outline-none"
>
  {#if canRunRefresh && route.page === 'home' && loadState.status === 'empty'}
    <h1 class="text-2xl font-semibold">No saved jobs yet</h1>
    <p class="mt-2 mb-4">Select <strong>Run</strong> to get your first jobs.</p>
  {/if}
  {#if canRunRefresh}
    <LocalRun
      view={route.page === 'home' || route.page === 'run' ? route.page : 'hidden'}
      snapshotTime={snapshot?.generated_at ?? null}
      onsuccess={() => refresh(false)}
      onmarketrecording={(recording) => { marketRecording = recording; }}
    />
  {/if}

  {#if route.page === 'run'}
    {#if !canRunRefresh}<NotFound />{/if}
  {:else if route.page === 'settings' && (canEditSettings || loadState.status === 'ready')}
    <Settings {snapshot} {canEditSettings} />
  {:else if loadState.status === 'loading'}
    <p role="status">Loading…</p>
  {:else if loadState.status === 'empty' || loadState.status === 'error'}
    {#if !(loadState.status === 'empty' && canRunRefresh && route.page === 'home')}
      <ErrorState
        message={loadState.status === 'empty' ? 'No snapshot yet' : loadState.message}
        onretry={() => {
          void refresh();
        }}
      />
    {/if}
  {:else if route.page === 'home'}
    <Home snapshot={loadState.snapshot} {now} {feedback} />
  {:else if route.page === 'jobs'}
    <Jobs
      snapshot={loadState.snapshot}
      {now}
      filters={route.filters}
      {feedback}
    />
  {:else if route.page === 'job'}
    <JobPage snapshot={loadState.snapshot} id={route.id} {now} {feedback} />
  {:else if route.page === 'about'}
    <About snapshot={loadState.snapshot} {now} />
  {:else if route.page === 'market'}
    <Market snapshot={loadState.snapshot} {marketRecording} />
  {:else if route.page === 'salary'}
    <Salary snapshot={loadState.snapshot} />

  {:else}
    <NotFound />
  {/if}
</main>
