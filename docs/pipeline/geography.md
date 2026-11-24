# Approximate workplace radius

The default local review and report admit only an approximate official workplace
address representative point within the configured hard straight-line radius from the configured origin. Distances are approximate, not commute
measurements or independently surveyed coordinate accuracy. Unknown and outside
jobs stay separate; title relevance never overrides the radius. Origin
coordinates and provenance belong in ignored local preferences
(`origin_latitude`, `origin_longitude`, `origin_source`); the public template
supplies no guessed coordinates.

Municipality and city labels are not radius proof unless the whole municipality
lies inside the radius; see [whole-municipality bound](location-resolution.md). NAV's feed contains address
text but no workplace coordinate fields. Its work-location schema is documented
in the [NAV reference](https://pam-stilling-feed.nav.no/api/openapi.json?v=default).
The tracked public hull file covers all Norwegian municipalities, without a
profile-specific window or reference coordinates. Shared municipality names
remain excluded. This wider coverage does not change the radius test or address
priority; it is a NAV-source building block, not a rule for future providers.
No municipal or postal centroid is accepted as workplace proof. Address lookup is an
explicit manual operation, not a side effect of review, scoring, or source
synchronization.

## Profile-origin lookup

Quick setup asks for a four-digit work-area postcode, keeps leading zeroes,
and automatically looks up Kartverket Postnummerområder. It shows the postcode
and poststed before asking for kilometres. This is not a home-address lookup.
On failure, enter another postcode or use `pulse init --advanced --step geography`
for manual coordinates. No origin is invented. Unchanged saved origins need no lookup.

`src/lib/server/profile/postcode-area.ts` allows only the fixed HTTPS WFS endpoint
`https://wfs.geonorge.no/skwms1/wfs.postnummeromrader`, with no redirects.
Two WFS 2.0 GML 3.2 requests share a 10-second deadline and a 64 KiB aggregate
response limit. The exact postcode filter must produce one member in the first
request (count 2), no member in the second (count 1, startIndex 1), and no next
link. Provider counters are not evidence: `numberMatched="unknown"` and
`numberReturned="0"` were observed even when members existed.

Only Polygon exterior rings and normative interior holes are supported, with at
most 2500 vertices and 16 rings. The exact SRS
`urn:ogc:def:crs:EPSG::4326` means latitude then longitude. Other SRS values,
MultiSurface nesting, nonfinite coordinates, unclosed or degenerate rings and
self-intersections fail closed. For several polygons, the largest absolute
planar shoelace exterior area wins. An area tie within 1e-12 of the larger area
fails. This is not a geodetic area claim.

The method tries at most 16 deterministic horizontal chords. It accepts a
midpoint only after checking that it is strictly inside the exterior and outside
every hole. This is an approximate interior point, not an exact centre or a
claim of the globally widest chord. There is no centroid, vertex, address or city
fallback. Origin selection does not call the place-name service.

The local Settings editor saves a home postcode and radius. It uses the same
lookup for a new postcode. An unchanged postcode with a usable saved place and
origin does not need another lookup. A failed lookup does not change settings.
The stored origin includes internal coordinates and provenance. The editor
shows only the saved postcode and place. Old area-postcode metadata from setup
can remain on disk; the pipeline does not use it. If it differs from the home
postcode, Settings does not confirm the place until a successful lookup.
Same-postcode, preferred and
nearby municipality preferences do not boost ranking. Municipality exclusions
still apply. Distance is not sent to model review.

## Approximate official address points

The Source service provides bounded lookup during refresh; see the
[resolver guide](location-resolution.md) for its evidence, safety limits, and
offline tests. It accepts only one exact official address and postcode match,
valid EPSG:4326 coordinates, and a valid numeric coordinate pair. Kartverket's
additional `stedfestingverifisert` flag may be true, false, or absent: the exact
representative point is accepted in each case. The point is approximate, not an
independent coordinate verification. No live point-population result is claimed
for this integration work.

`src/lib/server/filter/geography.ts` calculates haversine distance and
`GeoAssessment(status, distance_km, reason)`. Status is `inside`, `outside`, or
`unknown`. At least one approximate address point within the radius gives
inside; unresolved alternative work locations remain noted. All known points
outside give outside only when no unresolved alternatives remain; otherwise the
status is unknown. This does not establish that every task can be done from a
particular office or that a remote-work arrangement exists.

The optional `ad_locations` table stores UUID, point pairs, an
incomplete-location flag, and minimal provenance—not addresses or contacts.
`store_points` requires valid numeric coordinates, provenance, and the exact
expected ad change version; it rejects stale resolutions and leaves transaction
control to the caller. Every source ad replacement invalidates old points. Ad
deletion/expiry removes points through a database trigger. Existing databases
gain the table only through a writer connection; read-only review does not
migrate source state. Absent point tables or an unconfigured origin fail closed
as unknown.

`relevance.scored_jobs(..., geography='all')` keeps its broad compatibility
interface, with a `ScoredJob.geography` field. Explicit `inside`, `outside`, and
`unknown` filters are available. Default UI/report paths enforce `inside`,
regardless of title evidence. No origin values are printed in reports.
