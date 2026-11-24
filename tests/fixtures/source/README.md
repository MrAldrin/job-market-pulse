# Original synthetic Python Source container

`original-python-source.sqlite3.gz.base64` is a lossless transport encoding of an
original SQLite container created by the frozen CPython 3.13.11 recorder.
It is not a database reconstructed from a JSON dump and contains no private data.
It is separate from the sealed `port-oracle` fixtures and goldens.

- Historical recorder (not shipped): `tests/oracle/record/reproduce.py` at frozen change `a8674112`.
- Input bundle: sealed `basic-run`, synthetic only.
- Run: 2026-11-17, 07:18:29–07:18:43 UTC, in the permanent oracle workspace.
- Command: `uv run --offline --python 3.13.11 python tests/oracle/record/reproduce.py
  --output local_only/port-oracle-reproduction
  --check-goldens`.
- Result: seven bundles; two byte-identical runs each; 339 golden-identical files.
- Origin: newly generated `basic-run/installation/data/source.sqlite3` under the
  recorder's owned temporary root. Copied after success while its exclusive lock
  was held. No WAL, SHM or rollback-journal sidecar was present.
- Original bytes: 139264.
- Original SHA-256:
  `cb31cb6f2474225712943530d1a0f222160924468b189fe2c7211f7bb13ad820`.
- Encoded-file SHA-256:
  `6e433ce74c237d63a4333e0601e9f88a7bd137d9e3cbe3b7405a59cbfb3abbd5`.

`tests/source/oracle-copy-cases.ts` always decompresses this input into its own
temporary directory, checks the original hash and full logical capture against
the sealed Source boundary, and reads it through the actual read-only interfaces. It checks that bytes, schema, `schema_version`,
`user_version` and journal mode do not change. It does not run initialization or
migration on this container. A missing fixture fails the test; there is no skip
or dependence on ignored evidence. The same test separately checks a logical
reconstruction from the sealed JSON dump. Neither case is live integration proof.

Retained run, copy and ownership receipts are referenced from `jmp-745.28`.
Do not refresh this fixture without a new approved frozen-recorder window.
