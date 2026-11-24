# Local settings suggestions API

`POST /app/local-settings/suggestions` is available only in the selected,
writable local dashboard. It uses the local settings editor's Host, native
loopback socket, Origin and `X-CSRF-Token` checks. The request has a 1 KiB
limit. The route does not accept a query, a profile ID, or caller-supplied
job or settings data.

Send `{ "helper": "<helper name>" }` only on a button press. Use a helper
name from the table. Each request can make one call through the saved
Calibration harness, model and effort. It does not refresh, write settings,
change the snapshot, or record a proposal. The response is not cached.

| Helper | Input summary | Candidate change |
| --- | --- | --- |
| `profile_from_feedback` | `liked` and `disliked`: numbers of job titles sent (at most 12 of each) | Replace the current comparison profile text. Only explicit local up/down reactions linked to jobs in the same profile's saved snapshot count. The request to the harness also includes the current profile text. |
| `title_exclusion` | `poor`: number of sampled titles sent (at most 24); `checked`: number of saved snapshot jobs available for the check | Add one literal word or phrase to excluded title terms. At least two sampled, fully reviewed poor-fit titles must support the term and not already be excluded by an existing title term. No matching job in the snapshot can have a different or unknown fit. This check cannot predict future results. |
| `employer_exclusion` | `employers`: number of sampled candidates (at most 12); `checked`: number of saved jobs checked | Add one employer. At least two reviewed jobs from that employer must have poor fit. The matching feedback profile must be selected. All saved jobs with the same normalized employer name must have reviewed poor fit and no explicit like in that profile’s local feedback store. The model sees the candidate names and two supporting titles per name. |
| `preferred_term` | `liked`: number of sampled liked titles (at most 24) | Add one literal term from at least one sampled liked title. The server checks the term against the full current preferred list. The model sees the titles and a sample of saved preferred terms. |
| `remove_exclusion` | `candidates`: number of sampled exclusions that match liked saved jobs (at most 24) | Remove one current literal title or employer exclusion. The server uses the current Filter match rules. The model sees the candidates, their list names and one liked title per candidate. This replay does not prove past blocking or that removal would admit the job. A post-filter snapshot cannot establish that an exclusion never matched. |

A successful response has `helper`, `input`, and `proposal`. `proposal` is
`null` when there is not enough evidence or no supported change. Otherwise,
it has a `reason`, `evidence` entries with `job_id`, `title`, and `signal`
(`liked`, `disliked`, or `poor`), and an exact revision-bound `change` from
the [local settings editor contract](local-settings-api.md). Title and
preferred term proposals also carry `term`. Employer additions carry
`employer`, and removal proposals carry `rule`. Evidence refers to the selected
saved inputs, not to titles invented by the model. Profile text appears as a
diff from the saved base in the editor.

Approval submits the displayed proposal's `change` to the ordinary editor
save route. The editor writes one private file under its installation lock
and rejects a stale revision. Rejection discards the proposal in the browser
without a request. Neither action changes a saved snapshot.

The route returns `400` for invalid input, `403` for failed write authorization,
`404` when unavailable or when a query is present, `405` for a method other than
POST, `409` for a concurrent suggestion request, `413` for an oversized body,
`502` for an invalid harness result, `503` for unavailable saved inputs or a
missing harness, and `504` for a timeout. It does not return raw harness output
or diagnostics.
