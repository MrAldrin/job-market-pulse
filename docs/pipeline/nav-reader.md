# Local NAV reader

Run the reader through [owner-started refresh](../operations/local-pipeline.md#owner-started-refresh). The selected profile controls the source database. Check [NAV feed terms](nav-feed.md) before a live run. The retired standalone reader and HTML report are not supported commands.

## Source service

`src/lib/server/source/service.ts` owns bounded collection, evidence refresh, resolution and saved freshness checks. Each operation selects an absolute database path. Read-only operations pin a snapshot and do not create or upgrade a store. Writer operations recognize supported source schemas and refuse unrelated layouts. A selected refresh takes the source writer lock. Registering the service and checking app health do not open a store or request a token.

The NAV client counts token requests against its budget, bounds responses to 2 MB and rejects redirects. Its defaults are 30 requests, 90 seconds and ten ingest detail requests. The [local pipeline](../operations/local-pipeline.md) supplies a separate sync budget. Filter supplies admission policy; Source checks identity, version and evidence before giving data to consumers.

## What is retained and what the summary means

Source retains minimized active listing facts and scrubbed text where available. Salary extraction uses the original detail. Closure and expiry remove cached text according to the retention rules. Text fetched for one Judge request is version-checked and stays in memory. Missing or stale evidence is not a negative result. A saved source check is not a new source request.

[Observations](observations.md) are separate from source versions, ratings and delivery. Source checks use synthetic replies and fixture databases; they do not verify current access to NAV or owner data.
