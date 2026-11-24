# Unicode compatibility data

These public Unicode 15.1 files match frozen CPython 3.13.11. They are data, not
profile values. The [Unicode license](UNICODE-LICENSE.txt) applies.

- `unicode-casefold-15.1.json` contains full C/F mappings from
  <https://www.unicode.org/Public/15.1.0/ucd/CaseFolding.txt>.
- `unicode-properties-15.1.json` contains sorted inclusive code-point ranges from
  <https://www.unicode.org/Public/15.1.0/ucd/UnicodeData.txt>. The source SHA-256 is
  `2fc713e6a31a87c4850a37fe2caffa4218180fadb5de86b43a143ddb4581fb86`.
  `decimal` is category Nd; `alphanumeric` is L* or N* (Python `isalnum`).
  The word class adds underscore separately. `printable` excludes categories C*
  and Z*, except U+0020. Unlisted code points are unassigned. First/Last ranges are expanded
  before adjacent entries are combined. There are 64 decimal, 748 alphanumeric
  and 712 printable ranges.

- `unicode-assigned-15.1.json` contains 715 sorted, merged inclusive ranges
  from all 1,721 entries of
  <https://www.unicode.org/Public/15.1.0/ucd/DerivedAge.txt> (289,460 code points,
  including private-use, surrogate and noncharacter entries). The source SHA-256
  is `04e16379344bdb9973cdb6f6bf0a5dd66f7cd41b014cd9f79d848768ae757256`.
  Comments and age labels are removed; adjacent ranges are merged without
  changing membership.

- `unicode-simple-lower-15.1.json` contains the 1,433 nonempty simple-lowercase
  mappings from column 14 of the same tagged `UnicodeData.txt`. This is not
  full C/F case folding.
- `unicode-rejected-text-15.1.json` contains 24 merged ranges (2,283 points) of
  exactly categories Cc, Cf and Cs from the same tagged `UnicodeData.txt`.
  First/Last ranges are expanded before merging. Saved-phone summaries reject
  these characters, not all nonprintable text: Co, Cn and Z remain accepted.
  This removes reliance on unproved native-property stability. No actual
  category-version counterexample is claimed.
- `python-re-extra-cases-3.13.11.json` contains all 50 literal data entries from
  <https://raw.githubusercontent.com/python/cpython/v3.13.11/Lib/re/_casefix.py>.
  The source SHA-256 is
  `1b12d9136f23db6c3f6f26053fefc15ca964b886838c7b9c1fabf8d2efc1e5c8`.
  Historical preparation checks accepted only the assignment, numeric tuple
  entries, braces and comments during extraction, without executing Python. The
  [CPython license](CPYTHON-LICENSE.txt) applies; its tagged source is
  <https://raw.githubusercontent.com/python/cpython/v3.13.11/LICENSE>, SHA-256
  `78b12c3a81360b357002334f0e70ea0e92eebf7a9b358805c03c48484945f3bb`.

Historical preparation checks compared the derived tables with lossless
compressed copies of these exact public sources and checked each source hash.
The copies in `tests/fixtures/unicode/` remain as provenance, with the same
licenses as the derived tables. These checks are not part of the current suite.

Using these tables avoids changes caused by a newer JavaScript Unicode version.
No Unicode builder or live download runs in the application.

## Escaped literal matching

`src/lib/server/shared/literal-match.ts` uses simple lowercase and CPython's extra
cases for bounded literal `re.I` comparison. It keeps `ß` distinct from `ss`,
while matching `ß` with `ẞ`. The retained term boundary is always
`(?<!\\w)` and `(?!\\w)`, including punctuation endpoints. Word membership is
the frozen B2 alphanumeric table plus underscore. Full C/F `caseFold` stays a
separate operation for preference identity and normalized place names. This
helper is not a general Screen regex compiler or runtime.

## Frozen NFKC

`src/lib/server/shared/normalization.ts` preserves characters unassigned in 15.1
and normalizes only the assigned runs between them. This relies on the
[versioned UAX15 revision 54, section 3](https://www.unicode.org/reports/tr15/tr15-54.html#Versioning):
normalization results for assigned strings are stable across versions from 4.1.
Old-unassigned characters have no decomposition and canonical combining class
zero. They stay unchanged and block reordering and composition across the run
boundary. This is not permission to split at arbitrary assigned characters.
The underlying JavaScript normalizer must conform to Unicode 15.1 or later.

Historical preparation checks covered all 95,370 NFKC column applications in
the official 15.1 normalization suite and every assigned code point not listed
in Part 1. These exhaustive checks are not part of the current suite.
`tests/fixtures/unicode/NormalizationTest-15.1.txt.gz` is a lossless gzip copy of
<https://www.unicode.org/Public/15.1.0/ucd/NormalizationTest.txt>.
Its uncompressed SHA-256 is
`871238e37e3be0696ec2bd0891119a041b052da1a84485eda05a5438724b223e`.
The same Unicode license applies. Historical preparation cases also covered
post-15.1 outlined characters and combining marks, barriers, private-use
characters, noncharacters and lone surrogates. The retained source is provenance,
not a current test-coverage claim or a claim of unrestricted Python regex
compatibility. Current acceptance uses realistic Pulse cases and golden files.
