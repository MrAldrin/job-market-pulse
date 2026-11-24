# Pipeline seams

Use [the brick map](../architecture/bricks.md) and [module map](../architecture/module-map.md) for owners. The local runner composes explicit Effect service Layers. Registering a service or checking health does not select a profile, open its stores or start network work.

- Source gives Filter a read-only snapshot of selected current listings, versions and evidence. Filter supplies policy callbacks; it does not open a second NAV store. Existing NAV schema coupling remains for occupation evidence.
- Judge validates through the Filter contract rather than an independent parser. It rechecks selected inputs and source facts at completion. A receipt with unknown submission status is not automatically retried.
- Snapshot reads saved projections through the Judge, Source and Market owners. Select receives assessment requests or a saved-review projection, not Judge's tables. Dashboard reads validated snapshot data. Alert still uses the separate staged digest input.
- Tests replace HTTP and harness Layers with fakes. This checks composition without live requests.
