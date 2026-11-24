# Personal review

## Configured review

Use [owner-started refresh](../operations/local-pipeline.md#owner-started-refresh) to run review with the configured Pi or Claude Code harness. There is no separate retained `review-pi` or `review-claude` command. The old Pi shortcut must not start a full refresh in its place.

The installation-wide `local_only/models.toml` owns the model, effort, harness and batch size for each step. Configured calls follow [scope](../scope.md); a subscription does not establish API-key access. Keep source and personal text private. Ad text is data, not instructions.

## Reviewer readiness

The pipeline checks both configured harnesses before review. Judge uses the saved Source freshness check instead of refreshing the feed again. Full review reads ephemeral, version-bound current text. It rebuilds admission for a newer active detail before it uses that text.

## Saved state and reuse

Judge stores runs, attempts and accepted results in the selected profile's
review database. Filter settings decide which jobs qualify. Changing those
settings does not invalidate the saved decisions for jobs that still qualify.
TOML comments, formatting and key order do not change the parsed settings.

The title screen uses the listing summary, comparison narrative, preferred
terms and its prompt. Full review also uses verified ad text. Neither model
receives admission-only settings. A change to a listing can require a new
decision. A new feed version alone does not require another model call if the
app can verify the same review inputs. The app still validates admission,
source identity and expiry before accepting a new result.

A narrative, preferred-term or prompt change does not queue saved decisions
for review. The next snapshot marks affected displayed reviews as made with an
older profile or prompt. The app keeps compatible decisions from older review
databases. It does not rewrite the original audit records.

To reconsider eligible jobs with older decisions, run `pulse re-review --all`
or `pulse re-review --listings ID[,ID...]`. Use listing IDs, not titles.
The command re-screens older title decisions, including older rejections. Only
jobs that advance reach full review. If only the full-review prompt changed,
the command can keep the title decision. It uses saved source coverage and can
request current NAV ad detail and call the configured models. If the saved
source is not current, run a normal refresh first. Re-review captures locally;
it does not sync the feed or upload a snapshot. Resume
an interrupted manual review with the same command and selection. A manual
review can close an interrupted automatic re-judge without repeating its call.

## Automatic re-judge during refresh

After Judge finishes, refresh can make a second assessment for eligible jobs
at selected first-score levels. No levels are selected by default. The second
pass uses the Judge model by default or a separate configured model. A
separate model uses batches of at most 10 jobs.

The accepted second score replaces the first in the snapshot and shortlist.
The review database keeps both assessments and their model records.
Turning re-judge off, changing the selected model or changing the level list
does not remove accepted second scores. A compatible first assessment keeps
its second score across admission changes and unchanged ad text. Narrative
and prompt changes keep the saved score and can mark it as older. If Judge
accepts a new first assessment, refresh uses that result to decide whether a
second assessment is needed. An interrupted submitted re-judge is not retried
for the same first result and ad text. If it blocks refresh, turn re-judge off
to capture the saved results without a new second pass.

Incomplete or invalid replies do not establish completion. An unknown
submitted outcome is not automatically retried. Review snapshots and user
ratings are distinct records. Diagnostics keep bounded codes and usage, not
raw model replies.

Offline tests use synthetic harness replies and databases. They do not verify credentials, current provider availability or live model output.
