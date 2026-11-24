<script lang="ts">
  import { untrack } from 'svelte';
  import { claudePickerEfforts, type LocalReviewer, type LocalSettingsDocument, type LocalSettingsPost } from '../contracts/local-settings';
  import { claudeModelAliases, defaultRejudgeOptions, fitLevels, reviewerEfforts, type RejudgeOptions, type ReviewerEffort } from '../contracts/reviewer-settings';

  let { saved, saving, post }: {
    saved: LocalSettingsDocument;
    saving: boolean;
    post: (update: LocalSettingsPost) => Promise<void>;
  } = $props();

  const initial = untrack(() => saved.rejudge ?? defaultRejudgeOptions);
  const configured = untrack(() => saved.models.steps.rejudge);
  const keyFor = ({ provider, model }: Pick<LocalReviewer, 'provider' | 'model'>) => `${provider}/${model}`;
  let levels = $state<RejudgeOptions['levels'][number][]>([...initial.levels]);
  let same = $state(initial.same_as_judge);
  let harness = $state(configured.harness);
  let modelKey = $state(keyFor(configured));
  let effort = $state<ReviewerEffort | ''>(configured.effort);
  let provider = $state('');
  let manualModel = $state('');
  const control = 'min-w-0 rounded-md border border-control bg-background px-3 py-2';

  const candidates = $derived.by(() => {
    const available = harness === 'pi' ? saved.models.pi_catalog ?? [] : claudeModelAliases.map((model) => ({ provider: 'anthropic', model, efforts: claudePickerEfforts }));

    if (harness !== configured.harness) return available;
    const listed = available.find((entry) => keyFor(entry) === keyFor(configured));

    if (!listed) return [{ ...configured, efforts: [configured.effort] }, ...available];

    return available.map((entry) => entry === listed && !entry.efforts.some((value) => value === configured.effort)
      ? { ...entry, efforts: [configured.effort, ...entry.efforts] } : entry);
  });

  const chosen = $derived(candidates.find((entry) => keyFor(entry) === modelKey));
  const manual = $derived(harness === 'pi' && modelKey === 'manual');
  const efforts = $derived(manual ? reviewerEfforts : chosen?.efforts ?? []);

  function save() {
    const values = { levels: fitLevels.filter((level) => levels.includes(level)), same_as_judge: same };
    const revision = saved.models.revision;

    if (same) {
      void post({ kind: 'rejudge', revision, values, model: null });

      return;
    }

    const selected = manual ? { provider: provider.trim(), model: manualModel.trim() } : chosen;

    if (!selected || !effort || !efforts.some((value) => value === effort)) return;
    void post({ kind: 'rejudge', revision, values, model: { harness, provider: selected.provider, model: selected.model, effort } });
  }
</script>

<form onsubmit={(event) => { event.preventDefault(); save(); }}>
  <fieldset class="space-y-3 border-t pt-2" disabled={saving}>
    <legend class="font-semibold">Re-judge</legend>
    <p class="text-sm text-muted-foreground">Choose which first scores to review again during refresh. Clear all levels to turn re-judge off.</p>
    <div class="flex flex-wrap gap-3">
      {#each fitLevels as level (level)}
        <label><input type="checkbox" value={level} bind:group={levels} /> <span class="capitalize">{level}</span></label>
      {/each}
    </div>
    <label class="block"><input type="checkbox" bind:checked={same} /> Same as the Judge model</label>
    {#if !same}
      <div class="grid gap-3 sm:grid-cols-2">
        <label class="grid gap-1 text-sm">Re-judge harness
          <select class={control} bind:value={harness} onchange={() => { modelKey = ''; effort = ''; }}>
            <option value="pi">Pi</option>
            <option value="claude-code">Claude Code</option>
          </select>
        </label>
        <label class="grid gap-1 text-sm">Re-judge model
          <select class={control} bind:value={modelKey} onchange={(event) => {
            effort = candidates.find((entry) => keyFor(entry) === event.currentTarget.value)?.efforts[0] ?? '';
          }} required>
            <option value="" disabled>Choose a model</option>
            {#each candidates as entry (keyFor(entry))}
              <option value={keyFor(entry)} disabled={!entry.efforts.length}>{keyFor(entry)}</option>
            {/each}
            {#if harness === 'pi'}<option value="manual">Enter a Pi model ID</option>{/if}
          </select>
        </label>
        <label class="grid gap-1 text-sm">Re-judge effort
          <select class={control} bind:value={effort} required>
            <option value="" disabled>Choose an effort</option>
            {#each efforts as value (value)}<option {value}>{value}</option>{/each}
          </select>
        </label>
        {#if manual}
          <label class="grid gap-1 text-sm">Pi provider ID <input class={control} bind:value={provider} required maxlength="100" /></label>
          <label class="grid gap-1 text-sm">Pi model ID <input class={control} bind:value={manualModel} required maxlength="100" /></label>
        {/if}
      </div>
      {#if harness === 'pi'}
        <button type="button" class={control} onclick={() => void post({ kind: 'refresh_models' })}>Refresh Pi models for re-judge</button>
      {/if}
    {/if}
    <button type="submit" class={control}>Save re-judge settings</button>
  </fieldset>
</form>
