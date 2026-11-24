# Project glossary

These definitions describe current code and contracts, not proof of live operation.
Terms are in alphabetical order. The main-file links are also source references.
See [Pipeline bricks](bricks.md) for ownership and intended boundaries.

| Term | Definition | Brick or group | Main file / source |
| --- | --- | --- | --- |
| active mode | A digest selection mode that permits exceptional and strong fits while retaining the evidence, freshness and hard-constraint gates. | Select | [Module map](module-map.md) |
| ad | A source job advertisement whose updates can produce several feed events. | Source | [Module map](module-map.md) |
| assessment | A source-bound personal-fit judgment with a fit category, reason, evidence, uncertainties and hard-constraint status. | Judge | [Module map](module-map.md) |
| calibration | An explicit comparison of personal ratings and saved assessments with the profile context to prepare possible corrections, not an automatic profile edit. | Calibrate | [Module map](module-map.md) |
| candidate | At the Filter-to-Judge boundary, a listing that passed deterministic admission and appears in a candidate manifest. | Filter | [Module map](module-map.md) |
| dashboard bundle | A legacy captured collection of read-only HTML dashboard pages and navigation metadata, separate from the review UI and feedback store. | Snapshot | [Module map](module-map.md) |
| delivery | An explicitly attempted or recorded handoff of a notification through a channel, not preparation, preview or staging. | Alert | [Module map](module-map.md) |
| digest | A profile-bound notification selection result containing its status, chosen candidates and optional market context. | Select | [Module map](module-map.md) |
| family | The single role category assigned to an ad by the market taxonomy, including mixed-data and other categories. | Market | [Module map](module-map.md) |
| filter | A deterministic admission rule that removes jobs before model review, such as geography, occupation or an explicit exclusion. | Filter | [Module map](module-map.md) |
| fit | The personal-review category exceptional, strong, possible, poor or unknown, distinct from deterministic relevance evidence and user feedback. | Judge | [Module map](module-map.md) |
| full review | The stage that compares supplied ad text and facts with the person's profile and explicit constraints after accepted title screening. | Judge | [Module map](module-map.md) |
| funnel | The profile's set of listing IDs with a saved full-review result, without a current-manifest freshness test. | Select | [Module map](module-map.md) |
| funnel job | A listing in that saved full-review set, including poor-fit, earlier-review and closed jobs. | Select | [Module map](module-map.md) |
| hard constraints | Explicit compulsory personal limits whose combined review status is pass, fail or unknown, with geography already enforced before review. | Judge | [Module map](module-map.md) |
| harness | The executable agent program, currently Pi or Claude Code, used to invoke the selected model. | Judge | [Module map](module-map.md) |
| listing | A source job record tracked by its ad UUID and source version, rather than one feed event. | Source | [Module map](module-map.md) |
| manifest | The Filter output that binds a candidate batch to source facts, profile and preference fingerprints, title rules and coverage metadata. | Filter | [Module map](module-map.md) |
| market snapshot | A stored set of aggregate family and term counts with a time label, coverage basis and taxonomy version. | Market | [Module map](module-map.md) |
| narrative | The person's private profile text describing their background, direction, preferences and explicit limits. | Profile | [Module map](module-map.md) |
| observation | A minimized record of a listing ID and source version found by an explicit capture run, not evidence of review or delivery. | Source | [Module map](module-map.md) |
| outbox | Private staged notification artifacts and their delivery ledger, where staging does not mean sending. | Alert | [Module map](module-map.md) |
| passive mode | A quiet selection mode that permits only exceptional fits and does not fill a recommendation quota. | Select | [Module map](module-map.md) |
| preferences | Validated personal settings that currently mix deterministic filters, soft review context and display wording. | Profile | [Module map](module-map.md) |
| profile | One person's private configuration bundle, including narrative, preferences, storage paths and selection policy. | Profile | [Module map](module-map.md) |
| proposal | A version-bound suggested correction with evidence and a recorded lifecycle, where approval is separate from application. | Calibrate | [Module map](module-map.md) |
| provider | The service supplying the selected model, distinct from the harness program that invokes it. | Judge | [Module map](module-map.md) |
| rating | A profile-local five-choice personal-fit judgment bound to a saved full-review result, with append-only history. | Feedback | [Module map](module-map.md) |
| reaction | A phone-shortlist thumbs-up or thumbs-down judgment on the recommendation, independent of a star or five-choice rating. | Feedback | [Module map](module-map.md) |
| review run | A durable profile-scoped review unit with fixed candidate and context bindings, stage attempts and accepted results. | Judge | [Module map](module-map.md) |
| reviewer | A configured model-step identity containing harness, provider, model, effort and batch size, not a permission allow-list entry. | Judge | [Module map](module-map.md) |
| shortlist | The persistent display selection of saved exceptional matches, plus strong matches in active mode, that lack explicit closure evidence, ordered by fit and first-found date. | Select | [Module map](module-map.md) |
| snapshot | Saved state at a capture point, represented for portable dashboard data by the versioned snapshot JSON contract rather than proof of current source state. | Snapshot | [Module map](module-map.md) |
| star | A phone-shortlist save-for-later flag, independent of recommendation quality, rating, ordering or job lifecycle. | Feedback | [Module map](module-map.md) |
| taxonomy | The versioned deterministic rules that define market role families, term groups and classification patterns. | Market | [Module map](module-map.md) |
| title screen | The first model stage that rejects a clear mismatch or explicit exclusion and advances ambiguous candidates to full review. | Judge | [Module map](module-map.md) |

## Contexts and conflicts

- Candidate denotes the Filter output unless a specific stored or selected view is named.

## Comparison test terms

The offline oracle compares TypeScript output with stored outputs from the
former implementation.

| Term | Definition |
| --- | --- |
| golden file | A stored oracle output for one recorded input at one brick boundary; port tests compare against it. |
| intended deviation | A difference from the oracle that a reviewer accepted and wrote down. |
| oracle | The last Python commit, kept frozen; the TypeScript port is compared to its output on the same recorded inputs. |
| regression | A difference from the oracle that nobody has reviewed and accepted. |
