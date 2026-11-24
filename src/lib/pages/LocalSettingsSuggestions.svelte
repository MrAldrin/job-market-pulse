<script lang="ts">
  import { Either } from 'effect';
  import type { LocalSettingsDocument } from '../contracts/local-settings';
  import { settingsSuggestionsPath, SettingsSuggestionResult, type SettingsHelper } from '../contracts/settings-suggestions';
  import { decodeStrict } from '../contracts/support';

  type Change = NonNullable<SettingsSuggestionResult['proposal']>['change'];

  let { saved, saving, termsChanged, apply }: {
    saved: LocalSettingsDocument;
    saving: boolean;
    termsChanged: boolean;
    apply: (change: Change, onSaved: () => void) => Promise<void>;
  } = $props();

  const button = 'rounded-md border bg-background px-3 py-2 focus-visible:outline-2 focus-visible:outline-ring hover:bg-accent disabled:opacity-50';
  let pending = $state(false);
  let result = $state<SettingsSuggestionResult | null>(null);
  let status = $state('');
  const proposal = $derived(result?.proposal);

  const revisionFor = (kind: Change['kind']) => saved[kind === 'excluded_title_terms' ? 'filters' : kind]?.revision;

  const stale = $derived(proposal != null && proposal.change.revision !== revisionFor(proposal.change.kind));
  const titleChangeBlocked = $derived(proposal?.change.kind === 'excluded_title_terms' && termsChanged);

  const lines = (text: string) => text ? text.split(/(?<=\n)/u) : [];

  function visibleLine(line: string): string {
    const trailingSpace = line.replace(/[ \t\r\n]+$/u, '').length;

    return line.replace(/[\\\p{Cc}\p{Cf}\p{Z}\p{Default_Ignorable_Code_Point}]/gu, (character, index: number) => {
      switch (character) {
        case '\\': return '\\\\';
        case '\n': return '\\n';
        case '\r': return '\\r';
        case '\t': return '\\t';
        default: return character === ' ' && index < trailingSpace
          ? character : `\\u{${character.codePointAt(0)?.toString(16).toUpperCase()}}`;
      }
    });
  }

  function changedLines(before: string, after: string) {
    const oldLines = lines(before);
    const newLines = lines(after);
    let start = 0;
    let oldEnd = oldLines.length;
    let newEnd = newLines.length;

    while (start < Math.min(oldEnd, newEnd) && oldLines[start] === newLines[start]) start++;

    while (start < Math.min(oldEnd, newEnd) && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
      oldEnd--;
      newEnd--;
    }

    return { line: start + 1, before: oldLines.slice(start, oldEnd), after: newLines.slice(start, newEnd) };
  }

  async function generate(helper: SettingsHelper) {
    if (pending || saving) return;
    pending = true;
    result = null;
    status = 'Checking saved evidence…';

    try {
      const response = await fetch(settingsSuggestionsPath, {
        method: 'POST', mode: 'same-origin', redirect: 'error', referrerPolicy: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': saved.csrf_token },
        body: JSON.stringify({ helper }),
      });

      if (!response.ok) {
        status = response.headers.get('Content-Type')?.startsWith('text/plain') ? await response.text() : 'Could not get a suggestion.';

        return;
      }

      const received = Either.getOrThrow(decodeStrict(SettingsSuggestionResult)(await response.json()));

      if (received.helper !== helper) throw new Error('Unexpected suggestion');
      result = received;
      status = received.proposal ? 'Suggestion ready. Nothing was saved.' : 'No supported suggestion. Nothing was saved.';
    } catch {
      status = 'Could not get a suggestion.';
    } finally {
      pending = false;
    }
  }
</script>

{#snippet helper(id: SettingsHelper, label: string, help: string, disabled = false)}
  <li class="min-w-0 space-y-2 rounded-md border p-3">
    <button type="button" class={button} {disabled} aria-describedby={`help-${id}`} onclick={() => void generate(id)}>{label}</button>
    <p id={`help-${id}`} class="text-sm text-muted-foreground">{help}</p>
  </li>
{/snippet}

<section class="rounded-lg border bg-card p-4">
  <h3 id="settings-suggestions" class="text-lg font-semibold">AI settings suggestions</h3>
  <fieldset aria-labelledby="settings-suggestions" class="min-w-0 space-y-3 pt-2" disabled={saving || pending}>
    <p class="text-sm text-muted-foreground">These helpers use the saved Calibration model. No helper starts a refresh.</p>
    <ul class="grid gap-2 md:grid-cols-2">
      {@render helper('profile_from_feedback', 'Suggest profile edit', 'Sends the saved profile text and the title, job ID and reaction for up to 12 liked and 12 disliked jobs from the saved snapshot.', !saved.narrative)}
      {@render helper('title_exclusion', 'Suggest title exclusion', 'Sends up to 24 titles from fully reviewed poor-fit jobs.')}
      {@render helper('employer_exclusion', 'Suggest employer exclusion', 'Sends up to 12 employer names with repeated poor fit and two supporting job titles per employer.')}
      {@render helper('preferred_term', 'Suggest preferred term', 'Sends up to 24 liked job titles and a sample of saved preferred terms.', !saved.judge)}
      {@render helper('remove_exclusion', 'Check exclusions against liked jobs', 'Sends up to 24 current exclusions that match liked saved jobs. For each exclusion, it sends the list name and one liked job title.')}
    </ul>
    <p role="status">{status}</p>
    {#if result?.helper === 'profile_from_feedback'}
      <p>Input: {result.input.liked} liked and {result.input.disliked} disliked job titles from the saved snapshot.</p>
    {:else if result?.helper === 'title_exclusion'}
      <p>Input: {result.input.poor} sampled poor-fit job titles. Check scope: {result.input.checked} jobs in the saved snapshot.</p>
    {:else if result?.helper === 'employer_exclusion'}
      <p>Input: {result.input.employers} sampled employers with repeated poor fit. Check scope: {result.input.checked} jobs in the saved snapshot.</p>
    {:else if result?.helper === 'preferred_term'}
      <p>Input: {result.input.liked} sampled titles of liked saved jobs.</p>
    {:else if result?.helper === 'remove_exclusion'}
      <p>Input: {result.input.candidates} sampled current exclusions that match liked saved jobs. The snapshot cannot show which rules have never matched.</p>
    {/if}
    {#if proposal}
      {#if stale}
        <p>Settings changed. Request a new suggestion.</p>
      {:else}
        <div class="space-y-2 rounded-md border p-3">
          <h4 class="font-semibold">Proposed change</h4>
          <p class="text-sm text-muted-foreground">Nothing is saved without approval.</p>
          {#if result?.helper === 'title_exclusion' && result.proposal}
            <p>Add <strong class="wrap-anywhere whitespace-pre-wrap">{result.proposal.term}</strong> to excluded title terms.</p>
          {:else if result?.helper === 'employer_exclusion' && result.proposal}
            <p>Add <strong class="wrap-anywhere whitespace-pre-wrap">{result.proposal.employer}</strong> to excluded employers.</p>
          {:else if result?.helper === 'preferred_term' && result.proposal}
            <p>Add <strong class="wrap-anywhere whitespace-pre-wrap">{result.proposal.term}</strong> to preferred terms.</p>
          {:else if result?.helper === 'remove_exclusion' && result.proposal}
            <p>Remove <strong class="wrap-anywhere whitespace-pre-wrap">{result.proposal.rule}</strong> from {proposal.change.kind === 'filters' ? 'excluded employers' : 'excluded title terms'}.</p>
          {:else if proposal.change.kind === 'narrative' && saved.narrative}
            {@const diff = changedLines(saved.narrative.text, proposal.change.values)}
            <p>Profile text diff from line {diff.line}. Escape sequences show line breaks and hidden characters. Approval replaces any unsaved profile text.</p>
            <div class="grid gap-2 sm:grid-cols-2">
              {#each [{ label: 'Remove', lines: diff.before }, { label: 'Add', lines: diff.after }] as part (part.label)}
                <div class="min-w-0">
                  <h5 class="font-semibold">{part.label}</h5>
                  {#if part.lines.length}
                    <pre class="wrap-anywhere whitespace-pre-wrap">{part.lines.map(visibleLine).join('\n')}</pre>
                  {:else}<p>None</p>{/if}
                </div>
              {/each}
            </div>
          {/if}
          {#if titleChangeBlocked}<p>Save or discard your title term edits before you approve.</p>{/if}
          {#if proposal.change.kind === 'filters' || proposal.change.kind === 'judge'}
            <p>Approval replaces any unsaved edits in this list.</p>
          {/if}
          <p class="wrap-anywhere">Reason: {proposal.reason}</p>
          <ul class="list-disc pl-5" aria-label="Evidence">
            {#each proposal.evidence as item (item.job_id)}
              <li class="wrap-anywhere">{item.title} ({item.signal === 'poor' ? 'poor fit' : item.signal})</li>
            {/each}
          </ul>
          <button type="button" class={button} disabled={titleChangeBlocked}
            onclick={() => void apply(proposal.change, () => { result = null; status = 'Approved and saved.'; })}>Approve suggestion</button>
          <button type="button" class={button} onclick={() => { result = null; status = 'Rejected. Nothing was saved.'; }}>Reject suggestion</button>
        </div>
      {/if}
    {/if}
  </fieldset>
</section>
