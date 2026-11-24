<script lang="ts">
  import { onMount } from 'svelte';
  import { Either } from 'effect';
  import { claudePickerEfforts, LocalSettingsDocument, LocalSettingsPost, LocalSettingsSaved, localSettingsPath, PiModelCatalog, type LocalReviewer } from '../contracts/local-settings';
  import { claudeModelAliases, modelSteps, type ModelStep, type ReviewerEffort } from '../contracts/reviewer-settings';
  import { decodeStrict } from '../contracts/support';
  import { searchModes, searchModeNotificationHelp, type SearchMode } from '../search-mode';
  import { strip } from '../text-whitespace';
  import LocalNotifications from './LocalNotifications.svelte';
  import LocalProfileInputs from './LocalProfileInputs.svelte';
  import LocalRejudge from './LocalRejudge.svelte';
  import LocalSettingsSuggestions from './LocalSettingsSuggestions.svelte';

  const stepNames: Record<ModelStep, string> = {
    screen: 'Initial screening', judge: 'Personal review', rejudge: 'Repeat review', calibrate: 'Calibration',
  };

  const control = 'min-w-0 rounded-md border bg-background px-3 py-2 focus-visible:outline-2';
  const fieldClass = `${control} border-control focus-visible:outline-offset-2 focus-visible:outline-control`;
  const buttonClass = `${control} focus-visible:outline-ring hover:bg-accent disabled:opacity-50`;

  let saved = $state<LocalSettingsDocument | null>(null);
  let loading = $state(true);
  let saving = $state(false);
  let status = $state('');
  let step = $state<ModelStep>('judge');
  let harness = $state<LocalReviewer['harness']>('pi');
  let modelKey = $state('');
  let effort = $state<ReviewerEffort | ''>('');
  let searchMode = $state<SearchMode>('passive');
  let terms = $state<string[]>([]);
  let term = $state('');
  const selected = $derived(saved?.models.steps[step]);
  const modelId = ({ provider, model }: Pick<LocalReviewer, 'provider' | 'model'>) => `${provider}/${model}`;

  const models = $derived.by(() => {
    const available: PiModelCatalog = harness === 'pi' ? saved?.models.pi_catalog ?? [] : claudeModelAliases.map((model) => ({
      provider: 'anthropic', model, efforts: claudePickerEfforts,
    }));

    const existing = selected?.harness === harness ? selected : undefined;

    if (!existing) return available;
    const listed = available.find((model) => modelId(model) === modelId(existing));

    if (!listed) return [{ ...existing, efforts: [existing.effort] }, ...available];

    if (listed.efforts.includes(existing.effort)) return available;

    return available.map((model) => model === listed ? { ...model, efforts: [existing.effort, ...model.efforts] } : model);
  });

  const chosen = $derived(models.find((model) => modelId(model) === modelKey));
  const modelChanged = $derived(selected !== undefined && (harness !== selected.harness || modelKey !== modelId(selected) || effort !== selected.effort));

  const termsChanged = $derived(saved !== null && (terms.length !== saved.filters.excluded_title_terms.length
    || terms.some((value, index) => value !== saved?.filters.excluded_title_terms[index])));

  function loadStep() {
    if (!saved) return;
    const current = saved.models.steps[step];
    harness = current.harness;
    modelKey = modelId(current);
    effort = current.effort;
  }

  async function reload(signal?: AbortSignal) {
    loading = true;
    status = '';
    saved = null;

    try {
      const response = await fetch(localSettingsPath, { mode: 'same-origin', redirect: 'error', signal: signal ?? null });

      if (!response.ok) throw new Error('Load failed');
      saved = Either.getOrThrow(decodeStrict(LocalSettingsDocument)(await response.json()));
      loadStep();
      searchMode = saved.search_mode.mode;
      terms = [...saved.filters.excluded_title_terms];
      term = '';
    } catch {
      if (!signal?.aborted) status = 'Could not load current local settings. Check that the selected profile files and models.toml exist and are valid.';
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    const controller = new AbortController();
    void reload(controller.signal);

    return () => controller.abort();
  });

  async function post(update: LocalSettingsPost, onSaved?: () => void) {
    if (!saved || saving) return;
    const decoded = decodeStrict(LocalSettingsPost)(update);

    if (Either.isLeft(decoded)) {
      if (update.kind === 'location') {
        status = 'Enter a four-digit postcode and a radius greater than 0 and at most 1000 km.';
      } else if (update.kind === 'screen') {
        status = 'Use one word or phrase per line, with * only at the end.';
      } else if (update.kind === 'narrative') {
        status = 'Enter valid profile text that is at most 100 KB.';
      } else {
        status = 'Invalid settings. Check the values in the form before saving.';
      }

      return;
    }

    saving = true;
    status = '';

    if (update.kind === 'test_model') status = 'Testing the selected model…';

    if (update.kind === 'refresh_models') status = 'Refreshing the Pi model list…';

    try {
      const response = await fetch(localSettingsPath, {
        method: 'POST', mode: 'same-origin', redirect: 'error', referrerPolicy: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': saved.csrf_token },
        body: JSON.stringify(decoded.right),
      });

      if (!response.ok) {
        status = [400, 409, 413, 502, 503, 504].includes(response.status) && response.headers.get('Content-Type')?.startsWith('text/plain')
          ? await response.text() : 'Could not complete the local settings request.';

        return;
      }

      if (update.kind === 'test_model') {
        status = 'Model test passed. Settings were not saved.';

        return;
      }

      if (update.kind === 'refresh_models') {
        const pi_catalog = Either.getOrThrow(decodeStrict(PiModelCatalog)(await response.json()));
        saved = { ...saved, models: { ...saved.models, pi_catalog } };

        if (!chosen?.efforts.some((value) => value === effort)) effort = chosen?.efforts[0] ?? '';

        status = pi_catalog.length ? 'Pi model list refreshed.' : 'Pi did not report any model candidates.';

        return;
      }

      if (update.kind === 'test_notification') {
        status = 'Test notification sent.';

        return;
      }

      const { revision, location } = Either.getOrThrow(decodeStrict(LocalSettingsSaved)(await response.json()));

      if (update.kind === 'model') {
        const { step, harness, provider, model, effort } = update;
        const steps = { ...saved.models.steps, [step]: { harness, provider, model, effort } };
        saved = { ...saved, models: { ...saved.models, revision, steps } };
      } else if (update.kind === 'rejudge') {
        const steps = update.model === null ? saved.models.steps : { ...saved.models.steps, rejudge: update.model };
        saved = { ...saved, rejudge: update.values, models: { ...saved.models, revision, steps } };
      } else if (update.kind === 'excluded_title_terms') {
        saved = { ...saved, filters: { ...saved.filters, revision, excluded_title_terms: update.values } };
      } else if (update.kind === 'location') {
        if (location === undefined) throw new Error('Saved location is missing');
        saved = { ...saved, filters: { ...saved.filters, revision, location } };
      } else if (update.kind === 'filters') {
        saved = { ...saved, filters: { ...saved.filters, revision, ...update.values } };
      } else if (update.kind === 'judge') {
        saved = { ...saved, judge: { revision, preferred_terms: update.values } };
      } else if (update.kind === 'screen') {
        if (saved.screen) saved = { ...saved, screen: { ...saved.screen, revision, values: { ...saved.screen.values, ...update.values } } };
      } else if (update.kind === 'search_mode') {
        const schedule = saved.schedule && { ...saved.schedule, revision };
        saved = { ...saved, schedule, search_mode: { revision, mode: update.values } };
      } else if (update.kind === 'schedule') {
        saved = { ...saved, search_mode: { ...saved.search_mode, revision }, schedule: { revision, ...update.values } };
      } else if (update.kind === 'notifications') {
        const { enabled, dashboard_url, topic } = update.values;
        saved = { ...saved, notifications: { revision, enabled, dashboard_url, topic_configured: topic !== null || saved.notifications?.topic_configured === true } };
      } else {
        saved = { ...saved, narrative: { revision, text: update.values } };
      }

      status = 'Saved. The captured snapshot did not change.';
      onSaved?.();
    } catch {
      switch (update.kind) {
        case 'test_model': status = 'Could not confirm the model test result.'; break;
        case 'test_notification': status = 'Could not confirm the test notification result.'; break;
        default: status = 'Could not confirm the change. Reload current settings before trying again.';
      }
    } finally {
      saving = false;
    }
  }

  function submitSearchMode(event: SubmitEvent) {
    event.preventDefault();

    if (!saved || searchMode === saved.search_mode.mode) return;
    void post({ kind: 'search_mode', revision: saved.search_mode.revision, values: searchMode });
  }

  function submitModel(kind: 'model' | 'test_model') {
    if (!saved || !chosen || !effort || !chosen.efforts.includes(effort)) return;
    const { provider, model } = chosen;
    const selection = { revision: saved.models.revision, step, harness, provider, model, effort };
    void post({ kind, ...selection });
  }

  function addTerm() {
    const value = strip(term);

    if (value && !terms.includes(value)) terms = [...terms, value];
    term = '';
  }
</script>

<section aria-labelledby="local-settings" class="space-y-4">
  <div class="space-y-1">
    <h2 id="local-settings" class="text-lg font-semibold">Current local settings</h2>
    <p class="text-sm text-muted-foreground">Saving does not start a run or change the saved snapshot.</p>
  </div>
  {#if loading}
    <p role="status">Loading current settings…</p>
  {:else if saved && selected}
    <div class="grid gap-4 lg:grid-cols-2">
      <section aria-labelledby="current-search" class="min-w-0 lg:col-span-2 space-y-4 rounded-lg border bg-card p-4">
        <h3 id="current-search" class="text-lg font-semibold">Search rules</h3>
        <p class="text-sm text-muted-foreground">Filter edits change which jobs qualify. Jobs that still qualify keep their saved reviews.</p>
        <form onsubmit={submitSearchMode}>
          <fieldset class="space-y-3" disabled={saving}>
            <legend class="font-semibold">Search mode</legend>
            <label class="grid gap-1 text-sm">Recommend jobs
              <select class={fieldClass} bind:value={searchMode} aria-describedby="search-mode-help">
                <option value="passive">{searchModes.passive.label}</option>
                <option value="active">{searchModes.active.label}</option>
              </select>
            </label>
            <div id="search-mode-help" class="space-y-1 text-sm text-muted-foreground">
              <p>{searchModes.passive.label}: {searchModes.passive.help}</p>
              <p>{searchModes.active.label}: {searchModes.active.help}</p>
              <p>{searchModeNotificationHelp}</p>
              <p>The next run uses this choice. Saved reviews stay valid.</p>
            </div>
            <button type="submit" class={buttonClass} disabled={searchMode === saved.search_mode.mode}>Save search mode</button>
          </fieldset>
        </form>
        <LocalProfileInputs group="search" {saved} {saving} {post} />
      </section>
      <section aria-labelledby="current-review" class="min-w-0 lg:col-span-2 space-y-4 rounded-lg border bg-card p-4">
        <h3 id="current-review" class="text-lg font-semibold">Review settings</h3>
        <form class="space-y-3" onsubmit={(event) => {
          event.preventDefault();
          submitModel('model');
        }}>
          <fieldset class="space-y-3" disabled={saving}>
            <legend class="font-semibold">Models for this installation</legend>
            <p class="text-sm text-muted-foreground">Select one review step to edit. A save changes only that step.</p>
            <div class="grid gap-3 sm:grid-cols-2">
              <label class="grid gap-1 text-sm">Review step
                <select class={fieldClass} bind:value={step} onchange={(event) => {
                  const chosen = modelSteps.find((value) => value === event.currentTarget.value);
                  if (chosen !== undefined) step = chosen;
                  loadStep();
                }}>
                  {#each modelSteps.filter((value) => value !== 'rejudge') as value (value)}<option {value}>{stepNames[value]}</option>{/each}
                </select>
              </label>
              <label class="grid gap-1 text-sm">Harness
                <select class={fieldClass} bind:value={harness} onchange={() => { modelKey = ''; effort = ''; }}>
                  <option value="pi">Pi</option>
                  <option value="claude-code">Claude Code</option>
                </select>
              </label>
              <label class="grid min-w-0 gap-1 text-sm">Model
                <select class={fieldClass} bind:value={modelKey} onchange={(event) => {
                  effort = models.find((model) => modelId(model) === event.currentTarget.value)?.efforts[0] ?? '';
                }} required>
                  <option value="" disabled>Choose a model</option>
                  {#each models as model (modelId(model))}
                    <option value={modelId(model)} disabled={!model.efforts.length}>
                      {harness === 'pi' ? modelId(model) : model.model}{!model.efforts.length ? ' (no supported effort)' : ''}
                    </option>
                  {/each}
                </select>
              </label>
              <label class="grid gap-1 text-sm">Effort
                <select class={fieldClass} bind:value={effort} required>
                  <option value="" disabled>Choose an effort</option>
                  {#each chosen?.efforts ?? [] as value (value)}<option {value}>{value}</option>{/each}
                </select>
              </label>
            </div>
            {#if harness === 'pi'}
              <button type="button" class={buttonClass} onclick={() => void post({ kind: 'refresh_models' })}>Refresh Pi models</button>
              {#if saved.models.pi_catalog === null}<p class="text-sm text-muted-foreground">No cached Pi list. Refresh to find candidates.</p>{/if}
            {:else}
              <p class="text-sm text-muted-foreground">Claude Code uses Anthropic aliases.</p>
            {/if}
            <p class="text-sm text-muted-foreground">Listed models are candidates, not proof of access. Testing sends one short request through the selected harness, without saving or sending profile or job data.</p>
            <button type="submit" class={buttonClass} disabled={!modelChanged || !chosen || !effort}>Save model</button>
            <button type="button" class={buttonClass} disabled={!chosen || !effort} onclick={() => submitModel('test_model')}>Test this model</button>
          </fieldset>
        </form>
        {#key saved.models.revision}
          <LocalRejudge {saved} {saving} {post} />
        {/key}
        <LocalProfileInputs group="review" {saved} {saving} {post} />
      </section>
      <section aria-labelledby="current-timing" class="min-w-0 lg:col-span-2 space-y-4 rounded-lg border bg-card p-4">
        <h3 id="current-timing" class="text-lg font-semibold">Schedule and notifications</h3>
        <LocalProfileInputs group="schedule" {saved} {saving} {post} />
        {#if saved.notifications}
          {#key saved.notifications.revision}
            <LocalNotifications current={saved.notifications} {saving} {post} />
          {/key}
        {:else if saved.notifications === null}
          <p>Notification settings are unavailable. Check access to the local settings file.</p>
        {/if}
      </section>
      <section aria-labelledby="current-exclusions" class="min-w-0 lg:col-span-2 space-y-4 rounded-lg border bg-card p-4">
        <h3 id="current-exclusions" class="text-lg font-semibold">Exclusions</h3>
        <fieldset class="space-y-3 border-t pt-2" disabled={saving}>
          <legend class="font-semibold">Excluded title terms</legend>
          <p class="text-sm text-muted-foreground">These terms exclude matching job titles for this profile.</p>
          {#if terms.length === 0}
            <p>No excluded title terms.</p>
          {:else}
            <ul class="space-y-1">
              {#each terms as value, index (index)}
                <li class="flex flex-wrap items-center gap-2">
                  <span class="wrap-anywhere whitespace-pre-wrap">{value}</span>
                  <button type="button" class={buttonClass} aria-label={`Remove ${value}`} onclick={() => { terms = terms.filter((_, i) => i !== index); }}>Remove</button>
                </li>
              {/each}
            </ul>
          {/if}
          <form class="flex flex-wrap items-end gap-2" onsubmit={(event) => { event.preventDefault(); addTerm(); }}>
            <label class="grid gap-1 text-sm">New title term
              <input class={fieldClass} bind:value={term} required />
            </label>
            <button type="submit" class={buttonClass}>Add term</button>
          </form>
          <button type="button" class={buttonClass} disabled={!termsChanged} onclick={() => {
            if (saved) void post({ kind: 'excluded_title_terms', revision: saved.filters.revision, values: [...terms] });
          }}>Save title terms</button>
        </fieldset>
        <LocalProfileInputs group="exclusions" {saved} {saving} {post} />
      </section>
    </div>
    <LocalSettingsSuggestions {saved} {saving} {termsChanged} apply={(change, onSaved) => post(change, () => {
      if (change.kind === 'excluded_title_terms') terms = [...change.values];
      onSaved();
    })} />
  {/if}
  <div class={status ? 'sticky bottom-0 z-10 space-y-2 border-t bg-card py-2' : ''}>
    <p role="status">{status}</p>
    {#if !loading && !saving && status && !status.startsWith('Saved.')}
      <button type="button" class={buttonClass} onclick={() => { void reload(); }}>Reload current settings</button>
    {/if}
  </div>
</section>
