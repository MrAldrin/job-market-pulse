# Local feedback events API v1

`GET /api/v1/feedback-events` returns a complete current-control projection for
one server-bound profile on the local dashboard only. Railway returns 404.
It uses [feedback events v1](feedback_events.schema.json),
not the frozen starred-jobs response. See the
[synthetic response](fixtures/hosted_feedback.example.json).

## Request and authentication

- Use the same server-bound read-only bearer capability as
  `/api/v1/starred-jobs`. The server checks Host first, then one exact bearer
  header with constant-time comparison. A browser cookie is not sufficient.
- GET only. No query, body, caller-selected profile or storage path is accepted.
  The existing viewer proxy mount rules apply.
- Every response uses `Cache-Control: no-store`. No permissive CORS is added.
- Disabled capability: `404`. Invalid bearer: `401`. Other methods, including
  HEAD: `405`. Invalid request: `400`. Unsafe, missing or over-limit store: `503`.
  Errors do not disclose secrets, paths or source data.

These are application-handler rules. SvelteKit form CSRF can refuse a
cross-origin bodyless POST before the handler runs. See the app adapter row
in the [local app boundary](../docs/dashboard/new-dashboard.md#local-server-boundary) for that difference and
literal-target GET behavior. The handler keeps the same Host and bearer checks
and rejects any query marker it receives and every non-empty query. Local
checks do not establish deployed behavior.

## Response semantics and bounds

- The document header is `pulse.feedback_events`, version `1`, with `profile_id`
  and `events`. The response contains only `star` and `reaction` events with
  origin `phone_shortlist`. Consumers must ignore unknown future event kinds.
- All retained listing IDs for that profile are eligible, not only jobs in the
  newest snapshot. No ad text, profile text or job summaries are returned.
- A star has value `true`; a reaction has value `up` or `down`. Cleared controls
  are absent. This is current state, not an action history or a deletion stream.
  Replace the previous fetched document in full. Do not append old controls.
- IDs are `<kind>:<listing_id>:<updated_at>`, as in the local phone-store adapter.
  The store has one update time per listing, not one time per control. Events
  sort by UTC timestamp, then event ID. A valid empty document is a success.
- At most 50,000 source rows and 50,000 output events; at most 2 MiB of JSON.
  A limit failure returns no partial result.
- Source reads use the same read-only SQLite access as starred jobs. Each source
  database is limited to 32 MiB. The reader checks the schema and sets a 100 ms
  busy timeout.

The `/api/v1/starred-jobs` wire response is unchanged. The local endpoint
has offline tests only. No deployment, credential setup or live
acceptance is established by them.
