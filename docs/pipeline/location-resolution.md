# Approximate workplace location resolution

[Refresh](../operations/local-pipeline.md) resolves the candidates selected by Filter. Source owns the address lookup, saved evidence and a private profile-local continuation checkpoint. Filter owns the radius decision. There is no standalone resolver command in the retained CLI.

Use only a unique exact official address and postcode match for a representative point. If no point exists, a whole-municipality bound can prove that all possible points are inside. Do not use a municipality or postal centroid as proof. See [geography](geography.md) for the decision and its limits.

The pipeline limits location resolution to ten candidates per run. The address client bounds replies to 64 KiB and spaces requests by at least one second. Source records provenance against the current workplace version and does not hold a database transaction while waiting on HTTP.
