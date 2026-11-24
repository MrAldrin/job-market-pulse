<script lang="ts">
  import { untrack } from 'svelte';
  import Button from './ui/button/Button.svelte';

  type Column = {
    key: string;
    label: string;
    numeric?: boolean;
    sortable?: boolean;
  };

  type Row = Record<string, string | number | null>;

  type Sort = { key: string; dir: 'asc' | 'desc' };

  let {
    columns,
    rows,
    caption,
    initialSort,
  }: { columns: Column[]; rows: Row[]; caption: string; initialSort?: Sort } =
    $props();

  let sort = $state<Sort | undefined>(untrack(() => initialSort));

  const activeSort = $derived(
    columns.find((column) => column.key === sort?.key && column.sortable)
      ? sort
      : undefined,
  );

  const sortedRows = $derived.by(() => {
    if (!activeSort) return rows;
    const { key, dir } = activeSort;
    const numeric = columns.find((column) => column.key === key)?.numeric;

    return rows.toSorted((left, right) => {
      const a = left[key] ?? null;
      const b = right[key] ?? null;

      if (a === null) return b === null ? 0 : 1;

      if (b === null) return -1;

      const comparison = numeric
        ? Number(a) - Number(b)
        : String(a).localeCompare(String(b), 'nb');

      return dir === 'asc' ? comparison : -comparison;
    });
  });

  function toggleSort(key: string): void {
    sort = {
      key,
      dir: activeSort?.key === key && activeSort.dir === 'asc' ? 'desc' : 'asc',
    };
  }
</script>

<div
  class="min-w-0 rounded-lg border border-border bg-card text-card-foreground"
>
  <table class="w-full caption-bottom text-sm">
    <caption class="p-3 text-start text-muted-foreground">{caption}</caption>
    <thead class="border-b border-border">
      <tr>
        {#each columns as column (column.key)}
          <th
            scope="col"
            class="h-10 px-3 text-start align-middle font-medium"
            class:numeric={column.numeric}
            aria-sort={column.sortable
              ? activeSort?.key === column.key
                ? activeSort.dir === 'asc'
                  ? 'ascending'
                  : 'descending'
                : 'none'
              : undefined}
          >
            {#if column.sortable}
              <Button
                class="h-auto min-h-9 max-w-full whitespace-normal text-start"
                onclick={() => toggleSort(column.key)}
              >
                {column.label}
                <span aria-hidden="true"
                  >{activeSort?.key === column.key
                    ? activeSort.dir === 'asc'
                      ? '↑'
                      : '↓'
                    : '↕'}</span
                >
              </Button>
            {:else}
              {column.label}
            {/if}
          </th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {#each sortedRows as row, index (index)}
        <tr class="border-b border-border last:border-0 hover:bg-muted/50">
          {#each columns as column (column.key)}
            <td
              class="p-3 align-middle break-words"
              class:numeric={column.numeric}
              data-label={column.label}
            >
              {row[column.key] ?? '–'}
            </td>
          {/each}
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .numeric {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  td {
    overflow-wrap: anywhere;
  }
  @media (width < 600px) {
    table,
    thead,
    tbody,
    tr,
    th,
    td {
      display: block;
    }
    thead tr {
      display: flex;
      flex-wrap: wrap;
    }
    thead th {
      height: auto;
      padding: 0.5rem;
    }
    tbody tr {
      margin: 0.75rem;
      border: 1px solid var(--border);
      border-radius: var(--radius);
    }
    tbody tr:last-child {
      border: 1px solid var(--border);
    }
    td {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 2fr);
      gap: 0.75rem;
    }
    td::before {
      content: attr(data-label);
      color: var(--muted-foreground);
      text-align: left;
      font-weight: 500;
    }
  }
</style>
