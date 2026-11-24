<script lang="ts">
  import { invalidate } from '$app/navigation';
  import Dashboard from '../../lib/Dashboard.svelte';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
</script>

<Dashboard
  snapshot={data.snapshot}
  canGiveFeedback={data.canGiveFeedback}
  canEditSettings={data.canEditSettings}
  canRunRefresh={data.canRunRefresh}
  error={data.snapshotError}
  reload={() => invalidate('pulse:snapshot')}
/>
