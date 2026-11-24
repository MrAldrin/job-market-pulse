# Frozen Python oracle

These are synthetic comparison inputs and Python outputs for the TypeScript port.
They are not live source, model, delivery or deployment evidence. P1 is
`jmp-745.25`; the comparison rules are in `jmp-745.15` and `jmp-745.19`.

## Intentional Judge differences

The Python files stay frozen. TypeScript checks the following differences for
`jmp-745.20`:

- `basic-run` and `resume-run`: both stage prompts omit admission-only
  settings and candidate geography and occupation evidence. The prompt IDs
  change. Candidate identities, ad text and response templates still match.
- The Judge schema checks allow one nullable run-scope column for explicit
  re-review. New result contexts carry review material and fit-context
  digests; older stored contexts remain readable.
- The real read-only Judge adapter keeps the five full reviews and eight
  title rejections in the `resume-run` database. The five displayed review
  reasons get the older-profile-or-prompt marker. The adapter test compares
  the rest of the snapshot byte for byte. The saved-output oracle keeps
  its original historical snapshots unchanged.

## Historical recorder (not shipped)

The public checkout contains the saved inputs and outputs, not the frozen
Python checkout, recorder or its lock file. Use `bun run test:oracle` to check
TypeScript against the saved outputs. The procedure below is historical.

Use **CPython 3.13.11** explicitly.
Do not use ambient `uv` selection: Python 3.14 changes schedule time parsing.
The recorder rejects another Python version. Keep the existing `uv.lock`.

From a checkout containing the frozen recorder:

```sh
uv run --offline --python 3.13.11 python tests/oracle/record/reproduce.py \
  --output local_only/port-oracle-reproduction --check-goldens
```

`provenance.json` names P0's product-code base, not a self-referential P1 commit.

The wrapper runs each bundle twice in a fresh process with `unshare -Urn`.
Each process asserts that its Linux network namespace differs from its parent's
and that it has no routes. It also denies sockets, DNS and child processes.
No loopback server or real harness is started. The real HTTP handler uses an
in-memory accepted connection. Discord uses the real transport with an in-memory
HTTPS connection. Source and geocoder replies use strict external queues.
Linux user/network namespace support is required for this proof. Failure is not
silently replaced by a weaker replay.

The wrapper compares every output file byte for byte, then compares with these
goldens. It writes logs and `reproduction.json` under the selected ignored output.
It replaces only its own generated bundle directories. The fixed disposable
installation is `/tmp/pulse-port-oracle/<bundle>/installation`; an ownership
marker and a lock protect reuse. The recorder copies only files in the sealed
`basic-run/inputs/resources.json` inventory. That inventory names 201 tracked P0
product/resource files and their hashes; runtime replay needs no VCS command.
Before content reads, preflight rejects unknown files/directories and symlinks.
Known `__pycache__` and `.mypy_cache` directories are excluded without entering,
reading or copying them. A symlink with either cache name still fails preflight.
Verified bytes and file modes are copied; unknown resources are never copied.
This keeps product paths stable across checkouts without path normalization. Do not run two recorder jobs at the same time.

## Inputs and controlled services

Each `tests/fixtures/port-oracle/<bundle>/` has a sealed `manifest.json`, `inputs/`
and `responses/`. Manifests contain hashes of every local fixture file and
expected boundary outputs. The top-level output `provenance.json` hash is excluded
from that manifest index to avoid a self-reference; the replay comparison still
checks its complete bytes. Replays
verify the seals and verify that fixture bytes did not change. Bundle aliases use
`basic-run` for source/profile inputs and fixed review replies where stated.
`none.json` is an explicit empty local response list, not an unused model reply.
No fixture is a renamed real person or captured private installation. Only
`classification=synthetic` is accepted; this is not a private-capture tool.

Controlled inputs, not business-rule replacements:

- UTC wall clock: `2026-10-19T12:00:00+00:00`; timezone `UTC` for the process,
  with explicit `Europe/Oslo` schedule cases. Monotonic clock: `123.0`.
  Sleep is a no-op. These fixtures do not test elapsed-time budgets.
- UUID4 sequence starts at integer 10000. Listing IDs are fixed input UUIDs.
  Secret-token entropy is a fixed SHAKE-256 sequence. Host name is
  `oracle.synthetic.test`. These are invented test values, not credentials.
- Executable discovery uses the sealed `basic-run/inputs/environment.json` map,
  not the host PATH. Unknown executable lookups fail. CLI interpreter discovery
  is `/synthetic/bin/python3.13`, uv is `/synthetic/bin/uv`, and Pi is
  `/synthetic/pi`; absent tools return null. These paths are printed plans only.
  No command at those paths is executed. The recording interpreter remains the
  installed Python 3.13.11 above.
- Strict feed, detail, geocoder and model queues reject unexpected requests and
  unused replies. The real current-ad text fetch validates raw synthetic NAV
  details, source versions and snapshot bindings. Both Pi and Claude raw process
  envelopes pass through the real parsers; no process is launched.
- Init uses the real terminal adapter, 28 invented human topic answers, a fake
  postcode lookup and 26 strict fixed interview replies. Salary and workplace
  topics are processed locally, without a model turn. A real `profile.md` must
  be saved with the supplied human facts; every unconfirmed model reflection is
  checked absent from it. The fixture is source-not-ready, not interview-incomplete.
- File audit checks confine writes to the installation and assigned output.
  Reads of checkout `local_only/` are denied except the recorder's own output.
  Negative tests prove outside writes, private reads, sockets and processes
  fail. Synthetic resource canaries prove unknown files/directories and links
  are rejected before any resource content read, and changed sealed bytes fail. Snapshot capture also verifies source and market files stay byte-equal.

## Encoding and normalization

`record/support.py` is the Python definition B1 must copy. There is **no timestamp,
ID, path, float, error-text or business-value masking**. Nondeterministic inputs
are fixed before product imports, so no such masking was needed.

- JSON object keys are sorted; arrays retain product order. Sets are serialized
  in sorted order. Dataclasses retain every field. Paths and enums become text;
  durations are `{"$seconds": number}`. Unicode is retained, not transliterated.
- SQLite dumps include every table, column, table SQL, primary key, schema object,
  `user_version`, integrity result and foreign-key check. Rows sort by the JSON
  encoding of their primary-key values, in declared key order. Keyless tables
  sort by their complete encoded row. This is the only row normalization.
- BLOBs are lossless `{"$bytes_hex": "..."}` values. No SQLite file bytes are
  compared: page layout is not a brick contract. Absent stores are
  `{"present": false}` and are not initialized by capture.
- `snapshot/snapshot-v1.json`, prompts, raw model envelopes, replies, CLI stdout
  and stderr, HTTP bodies, Discord bodies and retained digest files preserve
  their bytes. Canonical JSON wrappers are a reversible typed serialization,
  not permission to remove fields. Source fixtures and raw replies remain
  separate from encoded boundary outputs.

Generated setup files use trackable artifact names under `setup/files/`.
`setup/file-index.json` preserves each exact original relative path, file mode,
size and SHA-256. This is artifact packaging, not content/path-value masking:
file bytes are unchanged, and absolute paths inside them remain intact. No
privacy ignore rule is weakened and no ignored file is force-added.

A difference fails comparison. Re-record only through this recorder. Review an
accepted difference under `jmp-745.19` and record it in the owning brick's documentation.
No Python product behavior was changed for P1.

## TypeScript output checks

`bun run test:oracle` compares complete snapshot JSON, the CLI export, the
digest, the phone shortlist and the digest after confirmed delivery. The tests
use synthetic inputs, real TypeScript rules and replayed external responses.
They do not compare private database dumps, library behavior or HTTP transport
spelling. Frozen files outside these checks remain available as Python reference
outputs. The tables below describe what Python recorded, not what Bun compares.

## Bundle × boundary coverage

`yes` means real Python code executed. `absent` means absence was recorded, not
that the brick executed. A dash means this scenario has no such boundary.

| Bundle | Profile | Source + resolver | Filter | Judge | Select / digest | Market | Snapshot + upload SQLite | Viewer / feedback | Alert | CLI / schedule |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| basic-run | yes | 20 listings; exact/ambiguous/missing address | yes | invalid reply, linked retry, title + full | yes | salary facts; history absent | yes | — | Discord reject/retry/ack; repeat quiet | 28 command handlers across this and setup; units/show |
| resume-run | yes | basic inputs | yes | interrupted durable attempt; reopen, explicit linked retry | yes | salary facts; history absent | yes | — | ledger absent | — |
| changed-removed | yes | two source runs; update and removal; real resolver | both states | store absent | no saved assessments | history absent | yes; no reviewed jobs | — | ledger absent | — |
| duplicate-alert | yes | basic inputs | yes | title + full | yes | salary facts; history absent | yes | — | real Discord + ledger; second selection sends nothing | — |
| market-history | yes | basic-like source + resolver | yes | store absent | no saved assessments | frozen synthetic backfill + two explicit captures | yes | — | ledger absent | — |
| setup-interview | yes, saved narrative; not source-ready | source absent | — | — | — | absent | absent | — | absent | successful init + completed guided interview; no timer |
| viewer-api | yes | basic inputs | yes | basic replay | yes | salary facts; history absent | yes | login, snapshot, Host/CSRF refusal, star/reaction/clear, bearer exports, real store/events | basic replay | — |

The page-free `dashboard-snapshot.sqlite3` is an active profile-local upload
container. JSON, shortlist and starred-job metadata are retained. A missing old
`dashboard_views` bundle is expected, not a legacy-provenance signal. Snapshot
capture never runs Source or Judge. Market captures are **explicit calls**:
Python refresh does not update market history. B5/B11 own that intended addition.

### Schema coverage

All rows and schema objects are captured, including empty tables. Empty rows do
not prove the corresponding write rule was tested.

| Store / boundary | Captured tables or fields |
| --- | --- |
| Profile | Full loaded bundle, paths, selection policy, preferences/narrative files; init readiness state |
| Source | `ads`, `ad_texts`, `ad_salaries`, `ad_application_deadlines`, `ad_detail_versions`, `ad_locations`, `ad_occupation_checks`, `ad_occupations`, `ad_status_evidence`, `events`, `pages`, `state`, `versions` |
| Filter | Complete candidate manifests, coverage, fingerprints, reasons and source bindings |
| Judge | `personal_state_schema`, `personal_state_profile`, `review_runs`, `review_run_candidates`, `stage_attempts`, `stage_attempt_candidates`, `stage_results`, `review_result_contexts`, `attempt_reviewers`, `attempt_diagnostics`, `model_call_log`, retained `review_consents` / `standing_consents` |
| Legacy completion ledger | `reviewed_identity_metadata`, `reviewed_identities`; real empty initialization is explicit before legacy CLI preparation |
| Select | Requests, saved ranked results, shortlist, text/HTML digest |
| Alert | `metadata`, `digests`, `digest_items`, `notified_versions`; staged/claimed/failed/delivered states and exact Discord requests |
| Market | `snapshots`, `counts`, `tech_term_counts`, `unknown_title_word_snapshots`, `unknown_title_word_counts`; loaded counts and snapshot salary/market facts |
| Snapshot transport | `digest_snapshots`, including JSON bytes, retained HTML, shortlist and starred metadata; old page bundle absent |
| Feedback | Real phone store schema/rows; star/reaction events after each change; real starred-jobs and feedback-events HTTP exports |
| Schedule | Three parsed periods, rendered service/timer units and show text; no scheduler installation |

## CLI operation coverage

`basic-run/inputs/cli-cases.json` is the data-driven operation inventory.
`cli-files.json` supplies invalid/binding inputs. Outcomes and exact exit status,
stdout and stderr are recorded. Parser help is separate evidence only. An
operation that exits through argparse or trips a safety guard fails recording.

| Retained root command | Actual handler case | Result |
| --- | --- | --- |
| init | setup-interview, guided terminal input | success; files + stdout/stderr |
| profile | check, with/without fixed model settings | ready report / missing-settings report |
| reviewers | list, with/without settings | success / validated refusal |
| status | saved local state | success |
| doctor | readiness report with incomplete setup | explicit non-ready report |
| contracts | check all tracked contract fixtures | success |
| feedback | export saved stores | success |
| snapshot | export saved facts | success |
| outbox | read delivered ledger | success |
| prepare | before/after explicit completion-ledger initialization | real schema refusal / success |
| preview | incomplete/invalid supplied review | validated refusal |
| stage | incomplete/invalid supplied review | validated refusal, no new staging |
| run | invalid supplied review through personal run | validated refusal |
| record-review | invalid supplied completed review | validated refusal |
| extract-text | manifest for another invented profile | binding refusal |
| close-review-run | nonexistent durable run | validated refusal |
| confirm-delivered | nonexistent staged digest | validated refusal |
| review-session | absent model settings | validated refusal |
| review-pi | check with absent model settings | validated refusal |
| review-claude | check with absent model settings | validated refusal |
| refresh | dry-run, no publish | plan success; no product process |
| run-scheduled | only-if-due on a Monday for Friday | not-due success; no refresh |
| schedule | show | success; render only |
| publish | preview | success; no Railway |
| deploy | preview | success; no Railway |
| dashboard | missing built dashboard | real build-readiness refusal |
| demo | missing built dashboard | real build-readiness refusal |
| dashboard-build | missing dashboard build inputs | real build-input refusal; no Bun |

The legacy completion ledger and durable Judge store are different namespaces in
the same profile DB. A Judge-only store lacks legacy completion tables, so
`prepare` first refuses it. The next case explicitly calls the existing product
ledger initializer, then preparation succeeds. No completed identities or new
business behavior are fabricated.

## Uncovered rules and limits

This is a recorder-gap inventory, not a claim that existing Python tests lack
these cases. Each port owner must also perform the runbook's own code/test audit.
Important gaps need a TS test or an added data-driven oracle case. Unresolved
replay gaps block Python removal in D; they must not become silent equivalence
claims.

| Owner bead | Cases not established by these goldens |
| --- | --- |
| B2 | Invalid/unknown TOML keys, settings conversion, multiple profiles and postcode/place failure variants |
| B3 | Multi-page continuation/rollback, transport outages/rate limits, expiry boundaries, municipality whole-boundary admission, coordinate extremes and concurrent source changes. Resolver exact/ambiguous/missing and inside/outside/unknown are executed here. |
| B4 | Every exclusion pattern, hard-radius boundary equality, tie permutations, active-versus-passive quota variations and unknown assessment blocking beyond the saved cases |
| B5 | Historical taxonomy drift, all salary forms/currencies/negotiable/grade cases and market-write failure. Known salary ranges, fixed pay and unknowns are present, not all rules. |
| B6 | Every malformed schema, output alias/symlink failure and corrupt legacy transport; existing P0 regression tests remain in the frozen tree |
| B7/B8 | Real listener/TLS behavior, rate limiting, built-app/browser/mobile flows, UI/pixel equality, container build and hosted acceptance |
| B9/B10 | 120/121 candidate batching, reuse/freshness races, changed profile/source during active review, retry exhaustion and all invalid envelopes. Changed/removed is Source/Filter coverage, not a claim of a second Judge run. |
| B11 | Real end-to-end subprocess runner, overlapping locks, scheduled refresh success/failure, timer install/status/remove. Composed brick calls, Judge resume, unit rendering and not-due suppression are recorded. |
| B12 | Multi-profile isolation, ratings/legacy-feedback writers and all corrupt/oversize bearer-source cases. Phone feedback and both bearer exports are real here. |
| B13 | Discord timeout, disconnect, 429, redirect and ambiguous acknowledgement variants. No real notification was sent. SMTP remains postponed. |
| B14 | Successful review harness invocation, valid legacy preview/stage/run/record/confirm/close/extract workflows, built demo/dashboard/build, applied publish/deploy, configured doctor readiness and extra ops-tool success paths. Actual safe root-command handler cases exist for all 28 commands; help does not close these gaps. |

There is no private bundle, actual product network/model call, service activation,
Railway action, timer installation or delivery to a person in this evidence.
