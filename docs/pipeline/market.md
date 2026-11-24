# Market counts

Market is off by default. With no local override, `config/market_taxonomy.toml`
disables taxonomy-based classification and recording. If there are no saved
Market readings, the dashboard shows them as unavailable, not as zero matches.
This does not turn off Salary. Source supplies saved facts; Market does not fetch ad text.

Enable Market with a versioned taxonomy in
`local_only/config/market_taxonomy.toml` at the installation root. Local
patterns use JavaScript regular expression syntax. An invalid override fails;
it does not fall back to the disabled default.

A successful recording writes a weekly pair: broad active title counts and detailed counts from Filter-admitted active jobs. A later recording for the same week replaces the pair. The detailed series records population and text/occupation coverage; absence of evidence is not a zero count. Use only like coverage and taxonomy when comparing periods. These counts describe the monitored NAV pool, not the whole labour market.

Snapshot v1 uses saved facts without requiring recorded Market history. Explicit v2 capture can include saved history and coverage metadata. The dashboard displays saved readings and does not start collection. See the [snapshot contract](../architecture/contracts.md) and [local pipeline](../operations/local-pipeline.md).

The selected profile's `market-snapshots.sqlite3` holds the recorded pair. The reader can combine it with explicitly selected archived history without changing either store. The current record wins for the same label and basis.

## Keep the previous taxonomy

Before switching an existing installation, keep its current local taxonomy if
it has one. If it used the previous tracked default, copy the unchanged
`config/market_taxonomy.toml` from the private base into
`local_only/config/market_taxonomy.toml`. Do not overwrite an existing local
override. Keep the same taxonomy version and the existing history stores. No
history conversion is needed. An installation that does not opt in skips new
recordings and keeps its saved history on disk.
