# Setup wizard

Run `pulse init`, or `bun src/cli/pulse.ts init` from the checkout.
Enter a profile ID, for example `scratch-tester`. Use at most 64 lowercase
letters and digits, with single hyphens between groups. On a rerun, Enter
keeps the displayed saved value. The current default profile is selected; `pulse --profile ID init`
selects another existing profile without switching the default. If old profiles
have no clear selection, use that explicit route.

Quick setup asks about the profile, AI settings, area, job areas, profile text
and schedule. It skips exclusion questions but retains saved exclusions.
The job-area step asks for comma-separated numbers, for example 1,4,6, and
shows child choices before the answer. It keeps a nonempty area selection.
It does not overwrite preferred terms, and a title term does not admit a job.
The choice list has 14 tracked level-1 labels observed on 2026-11-12. It is
not a complete NAV taxonomy.

`--advanced` includes exclusions and offers per-stage AI questions by default;
`--step exclusions` intentionally edits exclusions too. First quick setup asks
for one AI program, model and effort, then copies them to all four stages.
Quick reruns keep saved stage choices. `--step reviewer` offers keep or one
common replacement; use advanced setup for separate stage edits.

Only installed Claude Code and Pi programs appear. Pi can list local model
names with a bounded read-only command. You can always type a model name.
Claude Code and dry runs use typed names only. A list does not prove access.
Effort values are requests; unparseable help leaves support unknown. The requested
effort is stored unchanged. The selected program can adjust or reject an unsupported
effort when it runs. Pi can clamp it to a supported level; Claude Code can fall back
to a supported effort. Profile and job text go through the chosen program and its
configured model service.
Pulse does not verify that route, login or model access. Claude Code settings
control its service; Pulse records the provider as `anthropic`. A model starts
during setup only if you choose the guided interview below. Common named answers
need `ai_common = "yes"` before replacing saved stages. Stage-specific named answers take precedence. Save confirmation
is still required. Pulse uses Europe/Oslo without a time-zone question.
Legacy profile timezone values and imported timezone answers are ignored and kept.

Quick area setup asks for four digits, including leading zeroes, and automatically
looks up the work area in Kartverket Postnummerområder. It shows the postcode and
poststed, then asks for kilometres of straight-line distance, not travel distance.
The origin is an approximate interior-chord midpoint of the largest planar polygon,
not an exact centre or a metric-accuracy claim. It tries at most 16 deterministic
horizontal chords and checks the midpoint against the exterior and all holes.
Provider counters can say `numberMatched="unknown"` and `numberReturned="0"` even
when members exist; setup checks actual members and an empty second page instead.
Failure asks for another postcode and points to
`pulse init --advanced --step geography` for manual coordinates. No guessed
origin or quick manual menu is used. See the [method and bounds](../pipeline/geography.md#profile-origin-lookup).

Saved profile settings provide defaults. Explicit `--answers FILE` named TOML
values take precedence, including legacy flat files. A normal run does not load
old global answers. `--resume` deliberately loads only matching incomplete,
versioned recovery for the same profile, step and mode. Fingerprints reject
resume if committed inputs changed; run normally instead. Legacy files are not
automatically resumed. Confirmation-like imported answers never authorize saving.

Enter retains complete saved term lists, including literal commas inside entries.
Typed-list `--answers` values retain those entries too; an explicit `*_input`
value or a newly typed edit uses the existing comma-separated input rules.
Matching recovery retains changed coordinates and their source even when the
area label stays the same. A changed place query discards old origin evidence.

Normal runs can write private recovery answers before final save, including on
cancellation. They may contain sensitive answers. `--dry-run` writes no files,
answers, backups or directories and skips the AI interview; it can still perform public postal-area lookup. `--non-interactive` reports missing named
answers. A changed plan requires terminal confirmation.

## Profile interview

Choose one numbered method inside `pulse init`:

1. **Guided interview:** send answers to the selected AI program and its
   configured service. Pulse uses the validated pending Judge program, model
   and requested effort. Direct `--step interview` uses saved settings. There
   is no separate AI selection, login check or model substitution. No new
   terminal or profile directory is needed first.
2. **Short form:** answer locally without AI.
3. **Later:** leave the interview incomplete for now.

Guided reflections are labelled unconfirmed and are not saved as facts. Pulse
renders the draft from user answers, not model prose, and displays it as not
yet written. There is no separate draft-use approval. A failed call gives a
sanitized error and offers explicit retry with the same selection, short form
with retained answers, or later. Pulse does not retry automatically. The process
contract in `contracts/interview-session.md` gives bounds and limits.
A reported model ID can differ from your requested alias. Pulse gives a fixed
notice once per session: alias resolution or provider substitution is unverified;
Pulse did not change the request. It does not claim the actual model or effort
was verified, or save the reported ID as settings or user facts.

Salary is optional: one strict minimum annual amount before tax in NOK for a
full-time role. Workplace choices are equally acceptable on-site, hybrid and
fully remote; blank or none means unknown. Explicit conflicting ad evidence
fails a stated limit; missing evidence remains unknown. These answers do not
infer office days or geography. Other hard topics need explicit strictness.
Search mode is owned by [profile policy](../pipeline/profiles.md#policy),
not the interview.

Existing nonblank text is kept byte-for-byte by default, even if it is a
placeholder and not ready. You can adjust a recognized, unambiguous section
outside comments and fences, preserving all other bytes, or explicitly
re-interview the whole text. Ambiguous or unclosed comments stop section editing.
Automatic section editing supports plain UTF-8 text with LF or CRLF line endings
and exact headings. Ordinary comments and flat limit/preference bullets are
supported. Other line separators, indentation, structural containers, underlined
headings and raw HTML stop automatic section editing.
Unstructured legacy text is not automatically converted. Text over 128 KiB is
kept unchanged; move it aside before replacement, as explained by the wizard.
That size limit applies to interview input and the kept-text summary only. The
summary says **NOT CHECKED (interview/summary size limit)**, not globally unready.
Existing global matching and doctor size rules are unchanged.

Normal partial checkpoints contain user answers, strictness and bank position,
not model prose, history, drafts or save consent. They use the existing private
versioned recovery location and mode 0600. Missing target/profile directories
are not created just for a checkpoint; answers remain in memory with an
explanation. `--resume` checks profile, step, mode and fingerprints; fingerprints
are refreshed after apply. Partial status remains incomplete even if other
settings are saved. Dry-run skips all interview methods before form, model, temporary
files or checkpoints and makes no setup writes.

Existing custom paths and hidden settings stay intact unless deliberately
changed. Unknown profile and preference fields remain intact. Model and schedule
tables still use strict runtime contracts. If a saved AI program is unavailable,
quick reruns keep it; editing requires that program or an explicit replacement.

Quick schedule choices are Daily, Weekly, Every two weeks and No automatic runs.
Advanced setup also offers Monthly and intervals of N days or N weeks. Enter a
time as `1600` or `16:00`; both mean 16:00 Norway time. Enter keeps a saved
schedule, including custom intervals. On resume, the numbered menu shows the
recovered draft as its default; you can choose a different cadence. Saving does
not install a timer. Ambiguous profile representations stop an edit without
rewriting the file; unchanged schedules remain intact.

The summary reports kept, planned, incomplete, skipped or later without private
answers or coordinates. Existing replacements identify
the file and need specific confirmation, followed by **Save these settings?**.
A private timestamped backup is kept. Each file is replaced atomically, but the
whole plan is not atomic. An I/O error can leave earlier files applied.
Identical files with the required private mode are not rewritten; an unchanged
plan needs no write confirmation. Saving
does not install or start a timer, refresh jobs or send alerts. Local checks do
not prove live readiness. If reviewer settings are missing, the wizard asks you
to set up a reviewer before it offers the refresh command. Check model access
before your first refresh. See [profile files](../pipeline/profiles.md) and
[refresh permissions](local-pipeline.md#owner-started-refresh).

## Search mode

Setup owns the search mode in `profile.toml`: Just looking selects Exceptional;
Actively looking selects Exceptional and Strong, not Possible. Reruns default
to the saved choice. Interview answers and suggestions do not set this policy;
legacy mode suggestions are ignored with a notice. Later interview changes must
not add a duplicate mode question or let AI write the setting.
