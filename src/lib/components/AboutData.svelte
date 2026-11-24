<script lang="ts">
  import BoxedDisclosure from './BoxedDisclosure.svelte';

  let { items }: { items: { title: string; text: string }[] } = $props();
</script>

<BoxedDisclosure>
  {#snippet summary()}<span class="text-sm">About this data</span>{/snippet}
  <div class="space-y-3 text-sm">
    {#each items as item, index (index)}
      <section>
        <h3 class="font-medium">{item.title}</h3>
        <p class="break-words text-muted-foreground">{item.text}</p>
      </section>
    {/each}
  </div>
</BoxedDisclosure>
