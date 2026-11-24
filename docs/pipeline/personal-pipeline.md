# Personal pipeline

[Refresh](../operations/local-pipeline.md) binds the selected Profile, Source, Filter, Judge, Select and Snapshot. Filter enforces hard geography, occupation and exclusions. Deterministic relevance is not personal fit.

Judge screens titles, then reviews admitted current ad text with the selected narrative and personal limits. The manifest binds listing IDs and versions to profile and settings identity. Judge validates the supplied assessment and checks current state before accepting it. A change in relevant source or personal input can invalidate a saved result. A blocked or unfinished review is not completion. See [the fit contract](fit-contract.md) and [Judge](../review/hand-run-review.md).

Select applies mode, evidence, hard constraints and freshness to digest selection. The saved shortlist is separate: an earlier qualifying review can remain visible until explicit closure evidence. See [digest behavior](../alert/digest.md). Snapshot captures saved results without refreshing the source. [Alert](../alert/delivery.md) does not send merely because a snapshot was captured.

The retained CLI does not expose the old standalone preparation, manual review import, preview or outbox commands. Use `pulse demo` for an invented dashboard and `pulse refresh` only with the intended profile and permissions.

## Screen and admission rules

Explicit eligibility belongs to Filter, not Select. Preferred terms do not rescue absent or disallowed occupation evidence. Source location preparation does not require an interest score. The personal manifest uses neutral title rules by default; location and occupation preparation use the selected profile context. Screen title patterns use native JavaScript regular expressions. Full review receives only current, version-bound text approved by the admission callback. A saved shortlist is not evidence of present eligibility for a new digest.
