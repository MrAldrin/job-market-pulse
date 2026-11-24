# Product goal

## The job this system does

**Watch the job market for me so I do not have to. Bring opportunities to me,
not a list I must regularly inspect.**

The owner clarified this goal on 2026-10-17. This is the primary product reference;
it supersedes earlier descriptions that call a shortlist or dashboard the main
product. A dashboard is an optional inspection tool, not a weekly chore.

## Three parts, in priority order

The owner confirmed this order on 2026-10-28.

1. **Weekly alert.** A small, easily digested notification, only when there
   is something interesting the owner has not been told before. It is done
   when one real alert reaches the owner. Reliable unattended runs are a
   later concern. The channel is still open: any one or more of the built
   adapters (email, Discord, webhook, Grok) is acceptable.
2. **Dashboard.** Visited out of curiosity or to dig deeper: trends for
   positions over time, and jobs the alert did not recommend. The current
   dashboard is good enough for now; improve it only when a concrete idea
   comes up.
3. **Review loop.** Used occasionally, when recommendations feel wrong:
   rate what the agent suggested and refine the matching profile. Often
   triggered by spotting a missed job in the dashboard.

Page-specific purposes and agreed behavior: [UI overview](dashboard/ui-overview.md).

Repository cleanup is a separate side track. It exists to make agent work in
this repo easier; this goal decides where things belong.

## Running and hosting (current)

- Model calls use the owner's subscription through agent sessions, not an
  API key. The weekly run happens either on a schedule on the user's own
  machine or by hand from this machine. The scheduler is not chosen yet.
- Railway hosts the pages for now. Moving to an always-on machine later
  should be a small, swappable change. Current live service state is unknown; see [Railway deployment](operations/railway.md).
- Owner device and hosting-account details: see local owner context.

## Two levels of attention

- **Passive (comfortable at work):** keep a finger on the pulse, but push only
  exceptional, evidence-supported personal matches. Silence is a good outcome
  when there is nothing good enough. Do not fill a quota or force a wildcard.
- **Active ("I am looking now"):** the person explicitly asks for more. Bring a
  broader set of genuinely plausible matches, more often if requested, without
  requiring manual job searches. Hard limits still apply. More does not mean
  every keyword match.

Friday is the initial weekly processing/digest cadence. It does not require an
interruption every Friday. Market context should be concise and honest about
coverage. It should be available even when there are no recommendations.
Unsolicited market-only notifications should be opt-in.

## Personal fit, not keyword confidence

Judge against the person's private profile, ambitions, practical constraints,
and the actual advertisement. Separate evidence strength, personal fit, missing
facts, and model uncertainty. Never promote a deterministic keyword score into
an exceptional-fit verdict. Missing assessment, stale source state, an unknown
hard constraint, and a failed run must not masquerade as "no good jobs".

Avoid repeat recommendations unless the person requests them or a meaningful
change warrants another notification. Explain each recommendation briefly and
link to the source. Do not apply, contact employers, or change preferences
without separate permission. Feedback can propose improvements, not silently
rewrite what the person wants.

## More than one person

There is one user for now: the owner. Another person may be added later. Job notes
are shared household data, not a secret between them. A later privacy wall is
possible, but it is not a current requirement.

Each person still needs a distinct profile, hard limits, passive/active state,
feedback, delivery destination, and notification history. This keeps one run
from overwriting another. Do not inherit the owner's radius, occupation, or
ambitions for another person. Do not mix feedback or notification history.
Choose a small, portable design before building a hosted service. Separate
installations are acceptable initially. Isolated profile directories on one
trusted machine are a design option. They are not multi-user authentication or
a secrecy wall. Another person does not need a shared LLM conversation, account
system, VMs or Docker.

## Success and boundaries

Success is useful opportunities arriving with little attention cost, plus a
clear way to say "give me more now". Measure useful recommendations, unwanted
interruptions, duplicate suppression, coverage and freshness—not dashboard views
or notification volume. NAV excludes FINN-sourced jobs, so current coverage is
incomplete; additional sources require permitted access.

Build and test offline first. See [scope](scope.md) for product boundaries,
operator consent and verification limits. An
offline prototype is not evidence of a working unattended integration.
