<script lang="ts">
  import { untrack } from 'svelte';
  import type { LocalSettingsDocument, LocalSettingsPost } from '../contracts/local-settings';

  let { current, saving, post }: {
    current: NonNullable<LocalSettingsDocument['notifications']>;
    saving: boolean;
    post: (update: LocalSettingsPost) => Promise<void>;
  } = $props();

  let enabled = $state(untrack(() => current.enabled));
  let dashboardUrl = $state(untrack(() => current.dashboard_url ?? ''));
  let topic = $state('');
  const changed = $derived(enabled !== current.enabled || dashboardUrl !== (current.dashboard_url ?? '') || topic !== '');
  const field = 'rounded-md border border-control bg-background px-3 py-2 focus-visible:outline-2 focus-visible:outline-control';
  const button = 'rounded-md border bg-background px-3 py-2 focus-visible:outline-2 hover:bg-accent disabled:opacity-50';

  async function save() {
    await post({
      kind: 'notifications', revision: current.revision,
      values: { enabled, dashboard_url: dashboardUrl.trim() || null, topic: topic.trim() || null },
    });
    topic = '';
  }
</script>

<form onsubmit={(event) => { event.preventDefault(); void save(); }} autocomplete="off">
  <fieldset class="space-y-3 border-t pt-2" disabled={saving}>
    <legend class="font-semibold">Phone notifications</legend>
    <p>ntfy.sh is public. Anyone who knows the topic can read or send messages. Use a random topic and keep it secret.</p>
    <label class="flex items-center gap-2">
      <input type="checkbox" bind:checked={enabled} /> Enable automatic notifications
    </label>
    <label class="grid gap-1 text-sm">Secret ntfy topic
      <input type="password" class={field} bind:value={topic} autocomplete="off" spellcheck={false} maxlength={64} />
    </label>
    <p class="text-sm text-muted-foreground">{current.topic_configured ? 'Topic set. Leave empty to keep it.' : 'No topic set.'} Use 24 to 64 random letters, digits, hyphens or underscores.</p>
    <label class="grid gap-1 text-sm">HTTPS dashboard URL
      <input type="url" class={field} bind:value={dashboardUrl} maxlength={512} required={enabled} />
    </label>
    <p class="text-sm text-muted-foreground">Enter the address your phone uses, without credentials, a query or a fragment. This address is included in new match notifications.</p>
    <div class="flex flex-wrap gap-2">
      <button type="submit" class={button} disabled={!changed || (enabled && !current.topic_configured && !topic)}>Save notifications</button>
      <button type="button" class={button} disabled={changed || !current.topic_configured} onclick={() =>
        void post({ kind: 'test_notification', revision: current.revision })}>Send test</button>
    </div>
  </fieldset>
</form>
