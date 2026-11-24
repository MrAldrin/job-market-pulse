<script lang="ts">
  import { Schema } from 'effect';
  import { onMount } from 'svelte';
  import { LocalRunStatusResponse, localRunStartPath, localRunStatusPath } from '../contracts/local-run';
  import type { MarketRecording, StageName } from '../contracts/pipeline-progress';
  import { osloMinute } from '../format';
  import RunLog from './RunLog.svelte';
  import AlertDialog from './ui/alert-dialog/AlertDialog.svelte';
  import Button from './ui/button/Button.svelte';

  let { view, snapshotTime = null, onsuccess, onmarketrecording }: {
    view: 'home' | 'run' | 'hidden';
    snapshotTime?: string | null;
    onsuccess: () => Promise<void>;
    onmarketrecording: (recording: MarketRecording | undefined) => void;
  } = $props();

  const stageLabels: Record<StageName, string> = {
    'sync-source': 'Read NAV',
    'resolve-locations': 'Resolve locations',
    market: 'Record market data',
    review: 'Review jobs',
    snapshot: 'Save snapshot',
  };

  const stageStatuses = {
    pending: 'Pending',
    running: 'Running',
    succeeded: 'Complete',
    failed: 'Failed',
    recorded: 'Recorded',
    skipped: 'Skipped (Market recording is disabled)',
    waiting: 'Waiting to retry',
    unknown: 'Status not saved',
  };

  const stageColors: Record<keyof typeof stageStatuses, string> = {
    pending: 'bg-signal-neutral text-signal-neutral-foreground',
    running: 'bg-signal-active text-signal-active-foreground',
    succeeded: 'bg-signal-positive text-signal-positive-foreground',
    failed: 'bg-signal-failure text-signal-failure-foreground',
    recorded: 'bg-signal-positive text-signal-positive-foreground',
    skipped: 'bg-signal-neutral text-signal-neutral-foreground',
    waiting: 'bg-signal-caution text-signal-caution-foreground',
    unknown: 'bg-signal-neutral text-signal-neutral-foreground',
  };

  const runLabels = {
    idle: 'No saved run result.',
    running: 'Refresh in progress.',
  };

  const busyMessage = 'A run is already in progress';
  const changedMessage = 'The saved run changed. Check the run status and confirm again.';
  const decode = Schema.decodeUnknownSync(LocalRunStatusResponse);
  const scope = new AbortController();
  let result = $state<typeof LocalRunStatusResponse.Type>();
  let starting = $state(false);
  let statusUnavailable = $state(false);
  let observedOutcome = $state(false);
  const endTime = $derived(osloMinute(result?.ended_at ?? null));
  const snapshotMinute = $derived(osloMinute(snapshotTime));
  const currentStage = $derived(result?.stages.find((entry) => entry.stage === result?.current_stage));
  let startError = $state('');
  let snapshotError = $state('');
  let poll: Promise<void> | undefined;
  let confirmation: ReturnType<typeof AlertDialog>;
  let confirmedResetId = $state<string | null>(null);

  const requestSignal = () => AbortSignal.any([scope.signal, AbortSignal.timeout(10_000)]);

  async function readStatus() {
    const response = await fetch(localRunStatusPath, { signal: requestSignal() });

    if (!response.ok) throw new Error('Run status unavailable');

    return decode(await response.json());
  }

  async function updateStatus(): Promise<void> {
    try {
      const next = await readStatus();

      if (scope.signal.aborted) return;
      const previous = result;
      result = next;
      onmarketrecording(next.last_market_recording);
      statusUnavailable = false;

      // A run in another tab can start and finish between two polls.
      const changed = previous !== undefined && (
        previous.status !== next.status || previous.started_at !== next.started_at || previous.ended_at !== next.ended_at
      );

      // After a server restart, the disk record can repeat an outcome that
      // this tab already saw. Its saved end time precedes the in-memory one.
      const restoredOutcome = previous?.started_at != null && next.started_at === null &&
        previous.status === next.status && (next.ended_at === null || (
          previous.ended_at !== null && Date.parse(next.ended_at) <= Date.parse(previous.ended_at)
        ));

      if (changed) {
        if (!starting || previous.status === 'running') startError = '';
        snapshotError = '';
        observedOutcome = !restoredOutcome;
      }

      // An in-memory run can finish between page load and the first poll.
      const completed = next.status === 'succeeded' && (
        (changed && !restoredOutcome) || (previous === undefined && next.started_at !== null)
      );

      if (completed) {
        void onsuccess().catch(() => {
          if (!scope.signal.aborted) snapshotError = 'Could not load the new snapshot. Reload this page to try again.';
        });
      }
    } catch {
      if (!scope.signal.aborted) statusUnavailable = true;
    }
  }

  function check(): void {
    if (poll || starting || scope.signal.aborted) return;
    poll = updateStatus().finally(() => { poll = undefined; });
  }

  function ask(event: MouseEvent & { currentTarget: HTMLButtonElement }): void {
    if (starting || statusUnavailable || !result || result.status === 'running') return;

    confirmedResetId = result.reset_run_id;
    confirmation.open(event.currentTarget);
  }

  async function start(): Promise<void> {
    if (starting || scope.signal.aborted) return;

    const resetRunId = confirmedResetId;

    starting = true;
    startError = '';
    snapshotError = '';

    try {
      await poll;
      const current = await readStatus();

      if (scope.signal.aborted) return;

      if (current.status === 'running') {
        startError = busyMessage;

        return;
      }

      if (resetRunId !== current.reset_run_id) {
        startError = changedMessage;

        return;
      }

      const response = await fetch(localRunStartPath, {
        method: 'POST',
        referrerPolicy: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': current.csrf_token },
        body: JSON.stringify(resetRunId === null ? { confirm: true } : { confirm: true, reset_run_id: resetRunId }),
        signal: requestSignal(),
      });

      if (response.status === 409) {
        const message = await response.text();
        startError = message === busyMessage || message === 'The app is closing' ? message : changedMessage;
      } else if (response.status !== 202) startError = 'Could not start the refresh.';
    } catch {
      if (!scope.signal.aborted) startError = 'Could not confirm that the refresh started. Check the run status before trying again.';
    } finally {
      if (!scope.signal.aborted) await updateStatus();
      starting = false;
    }
  }

  onMount(() => {
    check();
    const timer = window.setInterval(check, 2_000);

    return () => {
      window.clearInterval(timer);
      scope.abort();
    };
  });
</script>

{#if view === 'run'}
  <h1 class="mb-4 text-2xl font-semibold">Run</h1>
{/if}

{#snippet runButton()}
  <Button disabled={!result || starting || statusUnavailable || result.status === 'running'} onclick={ask}>
    {result?.reset_run_id ? 'Reset and run' : view === 'run' ? 'Start refresh' : 'Run'}
  </Button>
{/snippet}

{#snippet refreshStatus()}
  <p role="status">
    {#if starting}
      Starting refresh…
    {:else if statusUnavailable}
      Run status unavailable. Trying again…
    {:else if result}
      {#if result.status === 'succeeded' || result.status === 'failed'}
        {#if view === 'run' && result.status === 'failed' && !endTime}
          Last run: End time unknown.
        {:else if observedOutcome && (result.status === 'succeeded' || endTime)}
          {result.status === 'succeeded' ? 'Refresh complete.' : 'Refresh did not complete.'}
        {:else}
          Last run: {result.status === 'succeeded' ? 'completed' : 'did not complete'}{endTime ? '' : ' (end time unknown).'}
        {/if}
        {#if endTime}
          <time datetime={result.ended_at}>{endTime}</time> (Oslo time).
        {/if}
        {result.error}
      {:else}
        {runLabels[result.status]}
        {#if result.current_stage}
          {#if view === 'run' && currentStage}
            <span class="mt-1 block">{stageLabels[result.current_stage]}: <span class="rounded px-1.5 py-0.5 font-semibold {stageColors[currentStage.status]}">{stageStatuses[currentStage.status]}</span></span>
          {:else}
            {stageLabels[result.current_stage]}.
          {/if}
        {/if}
        {#if result.retry_at}
          <span class:mt-1={view === 'run'} class:block={view === 'run'}>
            Next retry: <time datetime={result.retry_at}>{osloMinute(result.retry_at) ?? 'Time unknown'}</time> (Oslo time).
          </span>
        {/if}
      {/if}
    {:else}
      Checking run status…
    {/if}
  </p>
{/snippet}

{#snippet refreshMessages()}
  {#if startError || snapshotError}
    <p role="alert">{startError || snapshotError}</p>
  {/if}

  {#if result?.reset_run_id && !statusUnavailable}
    <p>Terminal alternative: <code>pulse refresh --no-publish --reset</code></p>
  {/if}
{/snippet}

{#snippet stages(detailed: boolean)}
  {#if result && !statusUnavailable && result.status !== 'idle'}
    <ul aria-label="Refresh stages" class={detailed ? 'divide-y' : 'flex flex-wrap gap-2'}>
      {#each result.stages as entry (entry.stage)}
        <li aria-current={entry.stage === result.current_stage ? 'step' : undefined}
          class={detailed ? 'flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2' : 'rounded-md border px-2 py-1'}>
          <span>{stageLabels[entry.stage]}:</span> <span class="rounded px-1.5 py-0.5 font-semibold {stageColors[entry.status]}">{stageStatuses[entry.status]}</span>
        </li>
      {/each}
    </ul>
  {:else if detailed}
    <p class="text-muted-foreground">{statusUnavailable ? 'Stage status unavailable.' : result ? 'No saved stages.' : 'Checking stages…'}</p>
  {/if}
{/snippet}

<section hidden={view === 'hidden'} aria-label="Local refresh" class="mb-4 text-sm">
  {#if view === 'run'}
    <div class="grid gap-4 md:grid-cols-2">
      <section aria-labelledby="refresh-status-title" class="space-y-3 rounded-md border bg-card p-4 text-card-foreground">
        <h2 id="refresh-status-title" class="text-lg font-semibold">Refresh status</h2>
        {@render refreshStatus()}
        {#if result?.status === 'failed' && !result.ended_at && !result.reset_run_id && !statusUnavailable && !starting}
          <p>Select <strong>Start refresh</strong> to try again.</p>
        {/if}
        <p class="border-t pt-3 text-muted-foreground">
          Last saved snapshot:
          {#if snapshotMinute}<time datetime={snapshotTime ?? undefined}>{snapshotMinute}</time> (Oslo time).{:else}Time unknown.{/if}
        </p>
        {@render runButton()}
        {@render refreshMessages()}
      </section>
      <section aria-labelledby="refresh-stages-title" class="space-y-2 rounded-md border bg-card p-4 text-card-foreground">
        <h2 id="refresh-stages-title" class="text-lg font-semibold">Stage status</h2>
        {@render stages(true)}
      </section>
    </div>
  {:else}
    <div class="space-y-2 rounded-md border p-3">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
        {@render runButton()}
        {@render refreshStatus()}
      </div>
      <a href="#/run" class="underline underline-offset-4">Show details</a>
      {@render refreshMessages()}
      {@render stages(false)}
    </div>
  {/if}
</section>

{#if view === 'run'}
  <RunLog lines={result?.log ?? []} {stageLabels} />
{/if}

<AlertDialog
  bind:this={confirmation}
  title={confirmedResetId === null ? 'Start a refresh?' : 'Reset the stopped run and start a new refresh?'}
  description="It reads new jobs from NAV and reviews them with your AI model."
  action={confirmedResetId === null ? 'Start refresh' : 'Reset and run'}
  onconfirm={start}
/>
