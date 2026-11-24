# Original synthetic Python Judge container

`original-python-review.sqlite3.gz.base64` is a lossless encoding of an original
SQLite container made by the frozen CPython 3.13.11 recorder. It is not rebuilt
from a JSON dump. It contains only the sealed synthetic `resume-run` data and is
separate from the sealed oracle inputs and goldens.

- Historical recorder (not shipped): `tests/oracle/record/reproduce.py` at frozen change `a8674112`.
- Fresh replay: 2026-11-17, 19:02:32–19:02:43 UTC; seven bundles, two
  byte-identical offline runs each, 339 golden-identical files.
- Command: `uv run --offline --python 3.13.11 python tests/oracle/record/reproduce.py
  --output local_only/port-oracle-reproduction
  --check-goldens`, from the permanent oracle workspace.
- Origin: the NEW run-2 `resume-run` Profile bundle's `paths.review_db`.
  Copied at 19:09:04 UTC after all recorder producers closed, while the same
  exclusive recorder lock was held. Marker, UID and non-symlink paths were
  checked. No WAL, SHM or rollback-journal sidecar was present.
- Original size: 180224 bytes.
- Original SHA-256:
  `69747861600fb58556a648fbec465c3f3548c2b36392b7bc8e63e35fbce65351`.

The [oracle consumer](../../snapshot/judge-adapter-bun.ts) decodes these bytes into
its own exclusive 0600 copy, fails if the fixture is missing, and uses the real
Judge reader and writer. Only that owned copy can change. This fixture is not
live integration proof.
Replay and copy log references are on `jmp-745.34`. Refresh requires a new
approved frozen-recorder window.
