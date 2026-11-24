<script lang="ts">
  import Button from '../button/Button.svelte';

  let { title, description, action, onconfirm }: {
    title: string;
    description: string;
    action: string;
    onconfirm: () => void;
  } = $props();

  const id = $props.id();
  let dialog: HTMLDialogElement;

  export function open(trigger: HTMLElement): void {
    trigger.focus();
    dialog.showModal();
  }

  function confirm(): void {
    dialog.close();
    onconfirm();
  }
</script>

<dialog
  bind:this={dialog}
  role="alertdialog"
  aria-labelledby={`${id}-title`}
  aria-describedby={`${id}-description`}
  class="fixed inset-0 m-auto w-[calc(100%-2rem)] max-w-md rounded-lg border border-border bg-background p-5 text-foreground shadow-lg backdrop:bg-black/50"
>
  <h2 id={`${id}-title`} class="text-lg font-semibold">{title}</h2>
  <p id={`${id}-description`} class="mt-2 text-sm text-muted-foreground">{description}</p>
  <div class="mt-5 flex flex-wrap justify-end gap-2">
    <!-- The dialog must focus the safer action when it opens. -->
    <Button variant="outline" autofocus onclick={() => dialog.close()}>Cancel</Button>
    <Button onclick={confirm}>{action}</Button>
  </div>
</dialog>
