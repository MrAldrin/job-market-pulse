# Quiet digest selection

`src/lib/server/select/core.ts` validates the supplied assessment bundle with `parseRequest` and selects a digest with `selectDigest`. Supply the evaluation time as epoch microseconds (`bigint`). `maxAgeMicros` defaults to seven days and `maxCount` defaults to 120. The API uses Effect `Either`: malformed input returns `DigestInputError`; a valid result has `ready`, `quiet` or `blocked` status. The pure renderers in `digest-render.ts` also return `Either`. The retained CLI has no standalone digest command.

## Assessment and selection contract

Passive mode includes exceptional fits. Active mode also includes strong fits. Both modes preserve input order without a quota and stop at the safety cap. Fit comes from an assessment, not deterministic relevance scoring.

The selected source snapshot must be caught up and current. Missing complete assessments, unknown expiry, unknown fit or unknown hard constraints block the digest. Expired candidates and candidates that fail a hard constraint are excluded. An assessment cannot predate the source check, be too old or be in the future. A blocked digest is not a quiet result.

The caller supplies already delivered listing ID and version pairs to suppress repeats. Staging or observation does not count as delivery. Select does not read stores, refresh sources, call reviewers or send notifications. See [Alert](delivery.md) for staging and delivery history.

## Market context

Market context is separate from the recommendation gate. Saved market and salary facts refer to the monitored population; missing evidence is unknown, not zero. See [Market counts](../pipeline/market.md).
