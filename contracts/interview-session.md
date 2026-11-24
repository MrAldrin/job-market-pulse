# Internal interview process and data boundary

This is an internal stdin process boundary, not a versioned snapshot or public
API. The controller in `src/cli/interview-session.ts` owns questions,
budgets and facts. `src/lib/server/judge/interview-turn.ts` owns process isolation
and stream limits. See those files for the authoritative validation.

For each turn Pulse sends a UTF-8 JSON prompt on stdin with
`current_question_id`, `trusted_question` (`ask`, `why`, `follow_up`) and
`untrusted_context` (user answers and existing text). Answers and existing text
are data, not instructions. No private answer is put in argv or diagnostic logs.
The selected program returns result text containing exactly this object, for
example for the current question `current_role`:

```json
{"question_id":"current_role","reflection":"You described planning work.","follow_up":null}
```

`question_id` must equal the current ID. `reflection` is a nonblank printable
single line of at most 1200 characters. `follow_up` is null or a zero-based
integer index into that question's trusted bank options. Booleans, duplicate
keys, extra keys, unknown IDs and out-of-range indices are rejected. Reflection
is labelled unconfirmed and not stored. Only user facts enter the deterministic
draft; the model does not write questions or a final draft.

The internal transport result keeps text separate from an untrusted reported
model ID. Pi's configured model and provider must match the request; an optional
`responseModel` is separate metadata. Claude must report one bounded, well-formed
`modelUsage` ID. There is no alias table or guessed date equivalence. The exact
requested model and effort remain in argv, without Pulse substitution. A differing
reported ID causes one fixed notice per session: alias resolution or provider
substitution is unverified, and Pulse did not change the request. This does not
verify the actual model or effort. Reported identity never enters settings,
recovered user facts, narrative or fingerprints.

All human asks, including menus, invalid answers, explicit retries, strictness
and follow-ups share a maximum of 56 attempts. At most 32 program subprocess
invocations include failures, invalid output and explicit retries. Each wait is
at most 60 seconds and remaining cumulative program wait; the cumulative limit
is 600 seconds and excludes human thinking. Prompt is at most 128 KiB UTF-8,
answer 4 KiB, result text 16 KiB, and combined stdout and stderr 1 MiB. Limits
fail explicitly, without silent truncation. The interview input and kept-summary
size boundary does not add a global legacy-profile admission limit. Pulse does
not automatically retry.
Client/provider internal retries are unknown: 32 invocations do not imply 32
HTTP or model requests.

The interview file plan carries a non-displayed digest of the original bytes, or
an explicit missing-file marker. The runner checks it before adopting a baseline
and checks that baseline again after fresh replacement and final save consent.
Reads for that interview baseline are bounded at 128 KiB plus one byte. This
protects against changes during draft display or confirmation; it is not an OS
compare-and-swap guarantee against a race at the final write.

Native calls are one-shot, using the selected program. Startup isolates tools,
extensions, hooks, MCP, skills, inherited context and session persistence. Pi's
fixed system and append-system prompts both prevent inherited prompt discovery.
These client controls are not an OS sandbox, credential barrier or guarantee
about provider retention. On every exit, including success, Pulse stops its owned
process group, reaps the direct child and finishes streams before temporary
cleanup. Capture reserves up to five seconds (at most half the invocation budget)
for cleanup inside the same absolute deadline, not an extra grace period. If
cleanup cannot be verified in that budget, the call fails with `cleanup_failed`
and retains the private temporary directory. Measured elapsed wait is not capped;
a late service result is rejected and disables further guided calls. These bounds
do not guarantee OS scheduling or process liveness.
A descendant escaping into a new session is outside this boundary; it
does not depend on a subreaper or cgroup. The transport is unavailable on
non-POSIX systems. Offline fake-process tests do not verify a live provider.

The TypeScript `InterviewTurn` service in `src/lib/server/judge/interview-turn.ts`
uses a detached POSIX child and signals only its owned group. It does not scan
`/proc`. If that group still exists or its state is unknown at the deadline,
the service returns `cleanup_failed` and retains the private directory. This is
stricter than the frozen Linux rule, which treats zombie-only groups as stopped.
A retained directory does not prove a live descendant remained. Judge's normal
review transport is separate.
