<script lang="ts">
  let {
    title,
    text,
    linkHref,
    linkText,
  }: {
    title: string;
    text: string;
    linkHref?: string;
    linkText?: string;
  } = $props();
</script>

<section class="space-y-2 rounded-lg border p-8 text-center">
  <h2 class="text-lg font-semibold">{title}</h2>
  <p class="text-muted-foreground">{text}</p>
  {#if linkHref && linkText}
    <a
      class="inline-block underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring"
      href={linkHref}>{linkText}</a
    >
  {/if}
</section>
