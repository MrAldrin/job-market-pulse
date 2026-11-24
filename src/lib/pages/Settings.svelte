<script lang="ts">
  import type { SnapshotSettings } from '../contracts/snapshot-settings';
  import { shortDate } from '../format';
  import { searchModes } from '../search-mode';
  import type { Snapshot } from '../snapshot';
  import { screenListView } from '../title-screen-terms';
  import Appearance from './Appearance.svelte';
  import LocalSettings from './LocalSettings.svelte';

  let { snapshot, canEditSettings }: { snapshot: Snapshot | null; canEditSettings: boolean } = $props();
  const settings = $derived(snapshot !== null && 'settings' in snapshot ? snapshot.settings : null);
  const personal = $derived(snapshot && "personal_inputs" in snapshot ? snapshot.personal_inputs : null);
  const rejudge = $derived(snapshot && "personal_inputs" in snapshot ? snapshot.settings.rejudge : undefined);

  const filterRows = [
    ['excluded_title_terms', 'Excluded title terms'],
    ['excluded_employers', 'Excluded employers'],
    ['allowed_occupation_categories', 'Allowed occupation categories'],
    ['preferred_terms', 'Preferred job terms'],
    ['excluded_municipalities', 'Excluded municipalities'],
  ] as const;

  const screenRows = [
    ['academic', 'Academic'], ['business_development', 'Business development'],
    ['sales', 'Sales'], ['tech_words', 'Technology terms'],
  ] as const;

  const reviewRows = [
    ['screen', 'Initial screening'], ['judge', 'Personal review'],
    ['rejudge', 'Repeat review'], ['calibrate', 'Calibration'],
  ] as const;

  const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

  function cadence(schedule: Exclude<SnapshotSettings['schedule'], { kind: 'never' }>): string {
    switch (schedule.kind) {
      case 'daily': return 'Daily';
      case 'weekly': return 'Weekly';
      case 'monthly': return 'Monthly';
      case 'every_n_days': return schedule.interval === 1 ? 'Every day' : `Every ${schedule.interval} days`;
      case 'every_n_weeks': return schedule.interval === 1 ? 'Every week' : `Every ${schedule.interval} weeks`;
    }
  }
</script>

{#snippet terms(label: string, values: readonly string[] | null)}
  <div>
    <dt class="text-sm text-muted-foreground">{label}</dt>
    <dd class="wrap-anywhere">{values === null ? 'Not shown (display limit)' : values.length === 0 ? 'None' : values.join(', ')}</dd>
  </div>
{/snippet}

{#snippet captured()}
    {#if snapshot === null}
      <p>No saved snapshot settings are available.</p>
    {:else if settings === null}
      <p>This snapshot does not include settings.</p>
    {:else}
      {@const schedule = settings.schedule}
      <p class="text-muted-foreground">
        Read-only settings captured on <time datetime={snapshot.generated_at}>{shortDate(snapshot.generated_at)}</time> (UTC).
      </p>

      <div class="grid gap-4 lg:grid-cols-2">
        <section aria-labelledby="settings-personal" class="min-w-0 space-y-1 rounded-md border p-3 lg:col-span-2">
          <h3 id="settings-personal" class="font-semibold">Personal review inputs</h3>
          {#if personal === null}
            <p class="mt-3">This snapshot does not include home location or the comparison profile.</p>
          {:else}
            {@const home = personal.home_location}
            <h4 class="mt-3 font-medium">Home location</h4>
            {#if home.label === null && home.home_postcode === null}
              <p>No home location was captured.</p>
            {:else}
              <p class="wrap-anywhere">{home.home_postcode ?? 'Postcode unknown'} → {home.label?.replace((home.home_postcode ?? '') + ' ', '') ?? 'Place unknown'}</p>
            {/if}
            <h4 class="mt-4 font-medium">AI comparison profile</h4>
            <p class="mt-2 whitespace-pre-wrap wrap-anywhere">{personal.narrative}</p>
          {/if}
        </section>

        <section aria-labelledby="settings-filters" class="min-w-0 space-y-1 rounded-md border p-3">
          <h3 id="settings-filters" class="font-semibold">Search filters</h3>
          <dl class="mt-3 grid gap-3 sm:grid-cols-2">
            <div><dt class="text-sm text-muted-foreground">Search mode</dt><dd>{searchModes[snapshot.profile.mode].label}</dd></div>
            <div><dt class="text-sm text-muted-foreground">Market only</dt><dd>{settings.policy.market_only ? 'Yes' : 'No'}</dd></div>
            <div><dt class="text-sm text-muted-foreground">Search radius</dt><dd>{settings.filters.radius_km} km</dd></div>
            {#each filterRows as [key, label] (key)}
              {@render terms(label, settings.filters[key])}
            {/each}
          </dl>
        </section>

        <section aria-labelledby="settings-titles" class="min-w-0 space-y-1 rounded-md border p-3">
          <h3 id="settings-titles" class="font-semibold">Title screening rules</h3>
          <dl class="mt-3 grid gap-3 sm:grid-cols-2">
            {#each screenRows as [key, label] (key)}
              {@const patterns = settings.title_screen[key]}
              {@const view = screenListView(patterns ?? [])}
              <div class="min-w-0">
                <dt class="text-sm text-muted-foreground">{label}</dt>
                <dd class="wrap-anywhere">
                  {#if patterns === null}Not shown (display limit)
                  {:else if view.terms.length}{view.terms.join(', ')}
                  {:else if !view.advanced.length}None
                  {/if}
                  {#if view.advanced.length}
                    <details class="text-sm">
                      <summary>Advanced (read-only)</summary>
                      <ul class="list-disc pl-4">
                        {#each view.advanced as pattern, index (index)}
                          <li><code class="wrap-anywhere whitespace-pre-wrap">{pattern}</code></li>
                        {/each}
                      </ul>
                    </details>
                  {/if}
                </dd>
              </div>
            {/each}
          </dl>
        </section>

        <section aria-labelledby="settings-source" class="min-w-0 space-y-1 rounded-md border p-3">
          <h3 id="settings-source" class="font-semibold">Sources</h3>
          <dl class="mt-3 grid gap-3 sm:grid-cols-2">
            <div><dt class="text-sm text-muted-foreground">Feed</dt><dd>{settings.sources.name.toUpperCase()} (excludes FINN-sourced ads)</dd></div>
            <div><dt class="text-sm text-muted-foreground">Maximum source age</dt><dd>{settings.policy.freshness_max_age_hours} hours</dd></div>
          </dl>
        </section>

        <section aria-labelledby="settings-review" class="min-w-0 space-y-1 rounded-md border p-3">
          <h3 id="settings-review" class="font-semibold">Review settings</h3>
          <dl class="mt-3 grid gap-3 sm:grid-cols-2">
            {#each reviewRows as [key, label] (key)}
              {@const reviewer = settings.review[key]}
              <div>
                <dt class="text-sm text-muted-foreground">{label}</dt>
                <dd class="wrap-anywhere">{reviewer.harness} · {reviewer.provider ?? 'Provider label not shown'} / {reviewer.model ?? 'Model label not shown'} · {reviewer.effort} · Batch size {reviewer.batch_size}</dd>
              </div>
            {/each}
          </dl>
          {#if rejudge}
            <p class="mt-3">Re-judge levels: {rejudge.levels.length ? rejudge.levels.join(', ') : 'Off'}.</p>
            <p>{rejudge.same_as_judge ? 'Re-judge uses the same model as Judge.' : 'Re-judge uses its own model.'}</p>
          {/if}
        </section>

        <section aria-labelledby="settings-schedule" class="min-w-0 space-y-1 rounded-md border p-3">
          <h3 id="settings-schedule" class="font-semibold">Schedule</h3>
          {#if settings.notifications_enabled !== undefined}
            <p>Phone notifications at capture: {settings.notifications_enabled ? 'On' : 'Off'}</p>
          {/if}
          {#if schedule.kind === 'never'}
            <p class="mt-3">No automatic runs configured.</p>
          {:else}
            <p class="mt-3">
              {cadence(schedule)}{schedule.weekday === null ? '' : ` on ${weekdays[schedule.weekday]}`}{schedule.day_of_month === null ? '' : ` on day ${schedule.day_of_month}`} at {schedule.time} ({schedule.timezone})
            </p>
            {#if schedule.kind === 'every_n_weeks' || schedule.kind === 'every_n_days'}
              <p>Saved anchor: {schedule.anchor ?? 'No valid saved anchor'}</p>
            {/if}
          {/if}
          <p class="mt-2 text-sm text-muted-foreground">This snapshot does not show whether a host timer is enabled.</p>
        </section>
      </div>
    {/if}
{/snippet}

<div class="space-y-6">
  <h1 class="text-2xl font-semibold">Settings</h1>
  <Appearance />
  {#if canEditSettings}<LocalSettings />{/if}
  {#if canEditSettings}
    <details class="min-w-0 rounded-lg border bg-card p-4">
      <summary class="cursor-pointer text-lg font-semibold">Settings used for the last saved results</summary>
      <div class="mt-4 space-y-4">{@render captured()}</div>
    </details>
  {:else}
    <section aria-labelledby="captured-settings" class="min-w-0 space-y-4 rounded-lg border bg-card p-4">
      <h2 id="captured-settings" class="text-lg font-semibold">Settings used for the saved results</h2>
      {@render captured()}
    </section>
  {/if}
</div>
