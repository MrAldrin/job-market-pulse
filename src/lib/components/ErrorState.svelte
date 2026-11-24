<script lang="ts">
  import Button from './ui/button/Button.svelte';

  let { message, onretry }: { message: string; onretry: () => void } = $props();
</script>

<section role="alert" class="space-y-4">
  <h1 class="text-2xl font-semibold">Could not load snapshot</h1>
  <p>{message}</p>
  <Button onclick={onretry}>Try again</Button>
</section>
