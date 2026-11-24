<script lang="ts">
  import { onMount } from 'svelte';

  let choice = $state<PulseAppearance>('system');
  let ready = $state(false);
  let failure = $state('');

  async function load() {
    try {
      const bridge = window.pulseAppearance;
      const saved = bridge ? await bridge.get() : document.documentElement.dataset.appearance;

      if (saved === 'dark' || saved === 'light') choice = saved;
      ready = true;
    } catch {
      failure = 'Cannot read the appearance setting.';
    }
  }

  onMount(() => { void load(); });

  async function select(value: string) {
    if (value !== 'system' && value !== 'light' && value !== 'dark') return;

    ready = false;
    failure = '';

    try {
      const bridge = window.pulseAppearance;

      if (bridge) await bridge.set(value);
      else {
        localStorage.setItem('pulse.appearance', value);

        if (value === 'system') delete document.documentElement.dataset.appearance;
        else document.documentElement.dataset.appearance = value;
      }

      choice = value;
    } catch {
      failure = 'Cannot save the appearance setting.';
    } finally {
      ready = true;
    }
  }
</script>

<section aria-labelledby="appearance" class="space-y-2 rounded-lg border bg-card p-4">
  <h2 id="appearance" class="text-lg font-semibold">Appearance</h2>
  <label class="flex flex-wrap items-center gap-3 text-sm">Color theme
    <select class="rounded-md border border-control bg-background px-3 py-2" disabled={!ready}
      value={choice} onchange={(event) => { const value = event.currentTarget.value; event.currentTarget.value = choice; void select(value); }}>
      <option value="system">System</option>
      <option value="light">Light</option>
      <option value="dark">Dark</option>
    </select>
  </label>
  {#if failure}<p role="status">{failure}</p>{/if}
</section>
