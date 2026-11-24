# NAV feed access before your first refresh

## Before your first refresh

> Read the [NAV API terms](https://arbeidsplassen.nav.no/vilkar-api) before you
> run your first refresh. Use of the NAV API means that you agree to those terms.

Setup with `pulse init` does not start a refresh. A live
[refresh](local-pipeline.md#owner-started-refresh) is a separate action.

## Where and when Pulse connects

- **Feed:** The NAV reader uses `https://pam-stilling-feed.nav.no` for the token,
  feed pages and ad details. A new source database starts at the newest feed
  page, not with a full backfill. Later runs continue from saved progress.
  The reader rejects redirects and does not follow application links.
- **Terms:** `arbeidsplassen.nav.no` hosts the terms linked above. It is not
  the feed host. See NAV's [consumer guide](https://navikt.github.io/pam-stilling-feed/)
  and the [project feed reference](../pipeline/nav-feed.md) for details.
- **Timing:** The reader requests a token when a live read in a session first
  needs a feed page or ad detail. Opening saved results does not contact NAV.
  Other refresh stages can make separate requests, for example to Kartverket
  for [address resolution](../pipeline/location-resolution.md).

## Tokens and limits

The API is free but not anonymous. For experimental use, the reader gets the
public token from `/api/publicToken` on the feed host. It keeps the token in
memory for that session and sends it as a bearer credential. The token can
rotate. Do not save it in files, put it in command arguments, or print it in
logs. You do not need to supply a token to Pulse. See the
[feed reference](../pipeline/nav-feed.md#do-we-need-another-account) for NAV's
separate private-token process.

The [refresh source sync](local-pipeline.md#stages) allows up to 100 NAV
requests, 240 seconds and 20 feed pages per attempt. Feed ingestion makes at
most ten ad detail requests within that budget. Token requests count
against the request budget. Each request has a limit of 15 seconds or the
remaining session time, whichever is less. Each response has a 2 MB limit.
These are Pulse limits for source sync, not NAV rate limits or a budget for
all refresh stages. See the [reader reference](../pipeline/nav-reader.md#source-service)
for the default client limits.

## What Pulse keeps and what it misses

The [reader](../pipeline/nav-reader.md#what-is-retained-and-what-the-summary-means)
keeps selected ad facts and scrubbed text for active ads in the local source
store. When the reader processes a closure or expiry, it removes cached ad
text. A saved snapshot is not proof that an ad is still active. If you
republish ads, the NAV terms require you to reflect updates and remove
inactive or deleted ads.

NAV excludes FINN-sourced vacancies. The feed does not cover the whole
Norwegian job market, and Pulse does not fetch listings from FINN.
