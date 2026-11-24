<script lang="ts">
  import type { LocalSettingsDocument, LocalSettingsPost } from '../contracts/local-settings';
  import { strip } from '../text-whitespace';

  let { group, saved, saving, post }: {
    group: 'search' | 'review' | 'schedule' | 'exclusions';
    saved: LocalSettingsDocument;
    saving: boolean;
    post: (update: LocalSettingsPost) => Promise<void>;
  } = $props();

  const control = 'min-w-0 rounded-md border bg-background px-3 py-2 focus-visible:outline-2';
  const field = `${control} border-control focus-visible:outline-offset-2 focus-visible:outline-control`;
  const button = `${control} focus-visible:outline-ring hover:bg-accent disabled:opacity-50`;

  const screenLists = [
    ['academic', 'Academic titles', 'Exclude jobs with academic titles.'],
    ['business_development', 'Business development titles', 'Exclude jobs with business development titles.'],
    ['sales', 'Sales titles', 'Exclude sales jobs unless their titles contain a technical word.'],
    ['tech_words', 'Technical words', 'Keep sales jobs with these words in the title. Other filters still apply.'],
  ] as const;

  const readText = (data: FormData, key: string) => String(data.get(key) ?? '');
  const newlines = (text: string) => text.replace(/\r\n?/g, '\n');
  const singleLine = (text: string) => text.replace(/[\r\n]/g, '');

  function readList(data: FormData, key: string, original: readonly string[]): readonly string[] {
    const text = newlines(readText(data, key));

    return text === newlines(original.join('\n')) ? original : text.split('\n').map(strip).filter(Boolean);
  }

  function submit(event: SubmitEvent & { currentTarget: HTMLFormElement }, kind: 'filters' | 'location' | 'judge' | 'screen' | 'schedule' | 'narrative') {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const section = saved[kind === 'location' ? 'filters' : kind];

    if (!section) return;
    const { revision } = section;

    switch (kind) {
      case 'location': {
        void post({ kind, revision: saved.filters.revision, values: {
          home_postcode: strip(readText(data, 'home_postcode')),
          radius_km: Number(readText(data, 'radius_km')),
        } });
        break;
      }

      case 'filters': {
        void post({ kind, revision, values: {
          excluded_municipalities: readList(data, 'excluded_municipalities', saved.filters.excluded_municipalities),
          excluded_employers: readList(data, 'excluded_employers', saved.filters.excluded_employers),
          allowed_occupation_categories: readList(data, 'allowed_occupation_categories', saved.filters.allowed_occupation_categories),
        } });
        break;
      }

      case 'judge': {
        if (saved.judge) void post({ kind, revision, values: readList(data, 'preferred_terms', saved.judge.preferred_terms) });
        break;
      }

      case 'screen': {
        if (!saved.screen) break;
        const values = { ...saved.screen.values };

        for (const [key] of screenLists) {
          const list = readList(data, key, values[key] ?? []);

          if (list.length || values[key] !== undefined) values[key] = [...new Set(list)];
        }

        void post({ kind, revision, values });
        break;
      }

      case 'schedule': {
        if (!saved.schedule) break;
        const { expression, anchor } = saved.schedule;
        const draftExpression = readText(data, 'expression');
        const draftAnchor = readText(data, 'anchor');
        void post({ kind, revision, values: {
          expression: draftExpression === singleLine(expression) ? expression : strip(draftExpression),
          anchor: draftAnchor === singleLine(anchor ?? '') ? anchor : strip(draftAnchor) || null,
        } });
        break;
      }

      case 'narrative': {
        if (!saved.narrative) break;
        const text = newlines(readText(data, 'narrative'));
        void post({ kind, revision, values: text === newlines(saved.narrative.text) ? saved.narrative.text : text });
        break;
      }
    }
  }
</script>

{#snippet list(name: string, label: string, values: readonly string[] | undefined)}
  <label class="grid min-w-0 gap-1 text-sm">{label}
    <textarea class={field} {name} rows="3" value={(values ?? []).join('\n')}></textarea>
  </label>
{/snippet}

{#if group === 'search'}
  {@const location = saved.filters.location}
  <form novalidate onsubmit={(event) => submit(event, 'location')}>
    <fieldset class="space-y-3 border-t pt-2" disabled={saving}>
      <legend class="font-semibold">Location</legend>
      <p class="text-sm text-muted-foreground">Pulse looks up your postcode area when you save a new postcode. The radius is a straight-line limit.</p>
      <div class="grid gap-3 sm:grid-cols-2">
        <label class="grid min-w-0 gap-1 text-sm">Home postcode
          <input class={field} name="home_postcode" inputmode="numeric" pattern="[0-9]{4}" value={location.home_postcode} required />
        </label>
        <label class="grid min-w-0 gap-1 text-sm">Search radius (km)
          <input class={field} name="radius_km" type="number" step="any" max="1000" value={location.radius_km} required />
        </label>
      </div>
      <p class="text-sm wrap-anywhere">{location.place === null ? 'No postcode area confirmed.' : `Saved location: ${location.home_postcode} → ${location.place}`}</p>
      <button type="submit" class={button}>Save location</button>
    </fieldset>
  </form>

  {#if saved.judge}
    <form onsubmit={(event) => submit(event, 'judge')}>
      <fieldset class="space-y-3 border-t pt-2" disabled={saving}>
        <legend class="font-semibold">Review preferences</legend>
        <p class="text-sm text-muted-foreground">Enter one value per line.</p>
        {@render list('preferred_terms', 'Preferred terms', saved.judge.preferred_terms)}
        <button type="submit" class={button}>Save preferred terms</button>
      </fieldset>
    </form>

  {:else}
    <p class="text-sm text-muted-foreground">Preferred terms are unavailable. Check judge.toml.</p>
  {/if}

  {#if saved.screen}
    <form onsubmit={(event) => submit(event, 'screen')}>
      <fieldset class="space-y-3 border-t pt-2" disabled={saving}>
        <legend class="font-semibold">Title screening lists</legend>
        <p class="text-sm text-muted-foreground">Enter one word or phrase per line. Add * at the end to match longer words, for example engineer*.</p>
        <div class="grid gap-3 sm:grid-cols-2">
          {#each screenLists as [key, label, help] (key)}
            {@const advanced = saved.screen.advanced[key] ?? []}
            <div class="min-w-0 space-y-1">
              <label class="grid gap-1 text-sm">{label}
                <textarea class={field} name={key} rows="3" aria-describedby={'screen-help-' + key}
                  value={(saved.screen.values[key] ?? []).join('\n')}></textarea>
              </label>
              <p id={'screen-help-' + key} class="text-sm text-muted-foreground">{help}</p>
              {#if advanced.length}
                <details class="text-sm">
                  <summary>Advanced (read-only)</summary>
                  <ul class="list-disc pl-4">
                    {#each advanced as pattern, index (index)}
                      <li><code class="wrap-anywhere whitespace-pre-wrap">{pattern}</code></li>
                    {/each}
                  </ul>
                </details>
              {/if}
            </div>
          {/each}
        </div>
        <button type="submit" class={button}>Save title screening lists</button>
      </fieldset>
    </form>

  {:else}
    <p class="text-sm text-muted-foreground">Title screening lists are unavailable. Check screen.toml.</p>
  {/if}
{:else if group === 'exclusions'}
  <form onsubmit={(event) => submit(event, 'filters')}>
    <fieldset class="space-y-3 border-t pt-2" disabled={saving}>
      <legend class="font-semibold">Employers, municipalities and occupations</legend>
      <p class="text-sm text-muted-foreground">Enter one value per line. Use the occupation category names from NAV.</p>
      <div class="grid gap-3 sm:grid-cols-2">
        {@render list('excluded_employers', 'Excluded employers', saved.filters.excluded_employers)}
        {@render list('excluded_municipalities', 'Excluded municipalities', saved.filters.excluded_municipalities)}
        {@render list('allowed_occupation_categories', 'Allowed occupation categories', saved.filters.allowed_occupation_categories)}
      </div>
      <button type="submit" class={button}>Save remaining filters</button>
    </fieldset>
  </form>
{:else if group === 'review'}
  {#if saved.narrative}
    <form onsubmit={(event) => submit(event, 'narrative')}>
      <fieldset class="space-y-3 border-t pt-2" disabled={saving}>
        <legend class="font-semibold">Comparison profile</legend>
        <p class="text-sm text-muted-foreground">Profile or prompt changes mark saved reviews as older on the next capture. To review those jobs again, use <code>pulse re-review --all</code>.</p>
      <label class="grid min-w-0 gap-1 text-sm">AI comparison profile text
          <textarea class={field} name="narrative" rows="14" value={saved.narrative.text} required></textarea>
        </label>
        <button type="submit" class={button}>Save comparison profile</button>
      </fieldset>
    </form>
  {:else}
    <p class="text-sm text-muted-foreground">Comparison profile text is unavailable. Check that the selected profile has a readable text file of at most 100 KB.</p>
  {/if}
{:else}
  {#if saved.schedule}
    <form onsubmit={(event) => submit(event, 'schedule')}>
      <fieldset class="space-y-3 border-t pt-2" disabled={saving}>
        <legend class="font-semibold">Local schedule</legend>
        <p class="text-sm text-muted-foreground">For example: “weekly friday 16:00”, “every 2 weeks friday 16:00” or “never”. Times use Europe/Oslo. Only interval schedules need a start date. Saving does not install, change or start a timer.</p>
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="grid min-w-0 gap-1 text-sm">Schedule expression
            <input class={field} name="expression" value={saved.schedule.expression} required />
          </label>
          <label class="grid min-w-0 gap-1 text-sm">Interval start date (YYYY-MM-DD)
            <input class={field} name="anchor" value={saved.schedule.anchor ?? ''} />
          </label>
        </div>
        <button type="submit" class={button}>Save schedule</button>
      </fieldset>
    </form>

  {:else}
    <p class="text-sm text-muted-foreground">The schedule is unavailable. Check profile.toml.</p>
  {/if}
{/if}
