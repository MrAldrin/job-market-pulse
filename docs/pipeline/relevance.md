# Deterministic relevance evidence

Filter scores retained titles without a model or network request. A fresh
installation has no built-in profession patterns. Filter ignores stored Source
topic tags by default. Explicit preferred terms still match as literal title
evidence.

## Evidence and ordering

- **Strong:** a configured role pattern matches the title.
- **Adjacent:** the title matches a topic pattern or an explicit preferred term,
  but no role pattern matches.
- **Uncertain:** no title evidence. A configured Source tag can count as weak
  evidence because its original context is not retained.

Role evidence is not a personal-fit assessment. Filter removes reflexive
phrases such as `utvikler deg` (develop yourself) before matching, unless an
explicit term includes the phrase. A term can map to the first matching topic
in a configured pack. Otherwise the term counts as its own signal.

Discovery ordering uses role tier, distinct evidence count and geography label
score. Stable ties use first observation and listing ID. Evidence does not
change [workplace radius](geography.md), occupation admission, or explicit
exclusions. Screen rules are separate; see [profile settings](profiles.md).

## Local evidence pack

An installation can opt in with `local_only/config/interest-patterns.json`.
The optional file supplies ordered `topics` and `roles` and a `source_tags`
allowlist. Patterns use JavaScript regular expressions with the `u` flag and
are case-sensitive unless the pattern itself accounts for case. Use only
trusted local patterns. Names must be unique within each list and must not
start with `term: `. Missing files give neutral evidence. An invalid file
fails instead of falling back.

```json
{
  "schema_version": 1,
  "topics": [{ "name": "first aid", "pattern": "[Ff]irst aid" }],
  "roles": [{ "name": "first aid", "pattern": "[Ff]irst aid instructor" }],
  "source_tags": []
}
```

The pack changes the scoring version used in the exact review binding. Only
the complete legacy matcher and tag allowlist keep the old version. A change
to these rules cannot hit the old exact stage or completion ledger binding. Judge can
still apply its separate source-material reuse policy. No saved record is
rewritten by installing the pack.

## Keep the previous evidence rules

This opt-in is for an existing installation that wants to keep its previous
scores and exact review bindings. A fresh installation can skip it. Do not run
a refresh on the new checkout until you have installed and checked the pack if
you want legacy behavior. Do not add the exported file to version control.

1. Before switching, run this Bash block in the private base checkout that
   still has the fixed `topics` and `roles` tables. It writes only to a private
   temporary directory. Note the path it prints.

   ```bash
   umask 077
   PULSE_LEGACY_DIR=$(mktemp -d) || exit 1
   export PULSE_LEGACY_DIR
   bun -e '
   import { resolve } from "node:path";
   import { pathToFileURL } from "node:url";
   const output = Bun.env.PULSE_LEGACY_DIR;
   if (!output) throw new Error("No export directory");
   const path = "src/lib/server/filter/title-evidence.ts";
   const base = pathToFileURL(resolve(path));
   const source = (await Bun.file(path).text()).replaceAll(/from "(\.\.[^"]+)"/g,
     (_, name) => `from "${new URL(name, base).href}"`);
   const modulePath = `${output}/legacy.ts`;
   await Bun.write(modulePath, source + `
   const entries = (rules: Record<TopicName, RegExp>) =>
     TOPIC_NAMES.map((name) => ({ name, pattern: rules[name].source }));
   export const pack = { schema_version: 1, topics: entries(topics),
     roles: entries(roles), source_tags: [...TOPIC_NAMES] };
   `);
   const { pack } = await import(modulePath);
   await Bun.write(`${output}/interest-patterns.json`, JSON.stringify(pack));
   console.log(`${output}/interest-patterns.json`);
   '
   ```

2. In the new checkout, run `bun tests/filter/legacy-evidence-proof.ts FILE`
   with the path printed in step 1. This checks synthetic assessments, exact
   review hashes and the completion ledger in a temporary root. If the check
   fails, stop before refresh. Do not edit the pack to force compatibility.
3. Copy the checked file to `local_only/config/interest-patterns.json` in the
   installation root. Keep file access private. Do not overwrite an existing
   override. Keep the saved review stores unchanged.

[Market opt-in](market.md#keep-the-previous-taxonomy) is separate.
