# Writing style

## Reference and limits

Use STE100-informed plain English for project prose. This is not a claim of
ASD-STE100 conformity or certification. The official reference is
[ASD Simplified Technical English](https://www.asd-ste100.org/).
On 2026-11-05, a direct public fetch returned HTTP 403. We did not obtain or
verify a complete edition, rule set or dictionary. Do not invent standard rules
or describe this project guide as the complete standard.

## Project rules

- Use short, direct sentences. Give each sentence one main idea.
- Use common words and active voice when the actor is known.
- State the actor, action, condition and result. Do not invent a missing actor.
- Put procedure steps in order. Separate instructions from explanations.
- Use the same technical term for the same thing.
- Keep facts, dates, quantities, permissions, warnings and uncertainty intact.
- Keep intended design, offline tests, historical events and current live status
  distinct. A successful local test does not prove a live integration works.
- Preserve commands, code, identifiers, paths, API names and quoted evidence.
- Keep linked headings stable. Check incoming links if a heading must change.
- Do not change a policy or resolve a factual conflict through copyediting.

## Shared technical terms

These are project technical names, not a verified STE100 dictionary supplement.

| Term | Use |
| --- | --- |
| owner | The person who approves project decisions and private operations. |
| source | An input service or its supplied data; name NAV when needed. |
| ad | A source job advertisement; not the same as a feed event. |
| feed event | A source change event; several events can concern one ad. |
| snapshot | Saved state at a specific capture point; not proof of current state. |
| personal review | A profile-specific suitability assessment. |
| relevance evidence | Deterministic title/topic evidence; not personal fit. |
| first found | The earliest saved full-review date in the phone shortlist. |
| approved | Permission or a recorded decision; not proof that it was applied. |
| implemented | Code exists; state its test and live-verification limits separately. |
| unknown / unverified | Keep these labels when evidence does not establish a fact. |
| outbox | Private staged delivery artifacts; staging is not delivery. |

Keep established names such as NAV, Arbeidsplassen, SQLite, Python, uv, Ruff,
ty, pytest, Pi, Claude Code, Luna, Sol, Railway, Hermes, Zensical, Jujutsu (`jj`),
API, UUID, HTML, MIME, SMTP and UI. Do not rename software interfaces or domain
values to meet a prose preference.

## Review

Compare each revision with its original. Check meaning before sentence length.
Record whether each canonical page was rewritten, left unchanged with a reason,
or deferred with a reason. Render symlinks are not separate editing targets.
