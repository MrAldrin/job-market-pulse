import { Clock, Context, Effect, Either, Layer, Option, Predicate, Schema } from "effect";
import {
  AddressResolution, AddressSession, LocationAdRow, LocationDetailRow, LocationVersionRow,
  OfficialAddressMatchCount, OfficialAddressResponse, ResolutionInput, ResolutionResult, StoredLocationRow,
  type LocationCandidate, type ResolutionOptions,
} from "../../contracts/source-locations.ts";
import { codepointOrder, pythonJson } from "../shared/python-json.ts";
import { normalized } from "../shared/text.ts";
import {
  fingerprintWorkLocations, hasCurrentWorkplaceBinding, norwegianCountries, pointPayloadJson,
  SUPPORTED_PROVIDER, validAddressText, validPostalCode, workplaceBinding,
} from "../shared/workplace-fingerprint.ts";
import { asObject, instant, locationLabels, sourceJson, timestamp, truthy, utcText, type SourceObject } from "./core.ts";
import { ResolutionError, SourceError } from "./errors.ts";
import { monotonicMillis, SourceHttp, transientStatus, type NavSession } from "./nav-client.ts";
import { hasTable, withReservedConnection, type SourceSql } from "./store.ts";

export { rejectionReasons } from "../../contracts/source-locations.ts";

export type { AddressResolution, AddressSession, AddressRejection, LocationCandidate, ResolutionOptions, ResolutionResult } from "../../contracts/source-locations.ts";

const decode = <A, I, Input>(schema: Schema.Schema<A, I>, value: Input, message = "Invalid location resolution data") => Schema.decodeUnknown(schema)(value).pipe(
  Effect.mapError(() => new ResolutionError({ message })),
);

export const matchesDetail = (detail: SourceObject, row: SourceObject, expectedDetailChanged: string, now: string, legacySkewMicros?: bigint): readonly SourceObject[] | null => {
  if (detail.uuid !== row.uuid || detail.status !== "ACTIVE") return null;
  const changed = Either.getOrNull(timestamp(detail.sistEndret));
  const expectedText = Either.getOrNull(timestamp(expectedDetailChanged));
  const changedTime = changed === null ? Option.none() : instant(changed);
  const expected = expectedText === null ? Option.none() : instant(expectedText);

  if (Option.isNone(changedTime) || Option.isNone(expected)) return null;
  const lag = expected.value - changedTime.value;

  if (legacySkewMicros === undefined ? lag !== 0n : lag < 0n || lag > legacySkewMicros) return null;
  const content = asObject(detail.ad_content);

  if (!content || content.uuid !== row.uuid || Either.isLeft(timestamp(content.updated))) return null;
  const employer = asObject(content.employer);
  const locations = content.workLocations;

  if (!employer || !Array.isArray(locations) || locations.length > 100 || !locations.every((v) => asObject(v) !== undefined)) return null;

  if (content.title !== row.title || employer.name !== row.employer || !Predicate.isString(row.locations)) return null;
  const labels = sourceJson(row.locations);

  if (Either.isLeft(labels) || !Array.isArray(labels.right)) return null;
  const actual = locationLabels(locations);
  const saved = [...labels.right].sort((a, b) => Predicate.isString(a) && Predicate.isString(b) ? codepointOrder(a, b) : 0);

  if (actual.length !== saved.length || actual.some((item, i) => item !== saved[i])) return null;
  const expiry = truthy(content.expires) ? timestamp(content.expires) : Either.right(null);
  const stored = truthy(row.expires) ? timestamp(row.expires) : Either.right(null);

  if (Either.isLeft(expiry) || Either.isLeft(stored) || expiry.right !== stored.right) return null;

  if (expiry.right) {
    const date = instant(expiry.right), current = instant(now);

    if (Option.isNone(date) || Option.isNone(current) || date.value <= current.value) return null;
  }

  return locations.map((item) => asObject(item)!);
};

// Python's address JSON decoder accepts bare nonfinite literals. For this
// endpoint they all fail the same numeric/type checks, so normalize them to
// floating overflow tokens before B2 decoding. Quoted strings stay untouched.
const addressJson = (raw: string) => sourceJson(raw.replace(
  /"(?:\\.|[^"\\])*"|(?:^|(?<=[\s[:,]))(?:-?Infinity|NaN)(?=$|[\s,\]}])/g,
  (token) => token.startsWith('"') ? token : token === "-Infinity" ? "-1e999" : "1e999",
));

export class AddressClient extends Context.Tag("pulse/AddressClient")<AddressClient, { readonly session: (deadline?: number) => Effect.Effect<AddressSession, ResolutionError> }>() {}

export const AddressClientLive = Layer.effect(AddressClient, Effect.gen(function* () {
  const http = yield* SourceHttp;

  return { session: (until?: number) => Effect.gen(function* () {
    const deadline = until ?? (yield* monotonicMillis) + 90_000;
    let last: number | undefined;
    const rejections: AddressSession["rejections"] = { invalid_input: 0, no_unique_match: 0, address_mismatch: 0, postcode_mismatch: 0, unsupported_coordinate_system: 0, invalid_coordinates: 0, invalid_verification_flag: 0 };
    const counts = { provider_true: 0, provider_false: 0, not_reported: 0 };

    const reject = (reason: keyof typeof rejections) => {
      rejections[reason]++;

      return null;
    };

    const session: AddressSession = { deadline, requests: 0, rejections, coordinate_verification_counts: counts,
      resolve: (address, postalCode) => Effect.gen(function* () {
        if (!validAddressText(address) || !validPostalCode(postalCode) || !Predicate.isString(address) || !Predicate.isString(postalCode)) return reject("invalid_input");

        if (session.requests >= 10) return yield* new ResolutionError({ message: "Address request budget exhausted" });
        let now = yield* monotonicMillis;
        const delay = last === undefined ? 0 : Math.max(0, last + 1000 - now);

        if (now + delay >= deadline) return yield* new ResolutionError({ message: "Resolution time budget exhausted" });

        if (delay) yield* Effect.sleep(delay);
        now = yield* monotonicMillis;

        if (now >= deadline) return yield* new ResolutionError({ message: "Resolution time budget exhausted" });
        const query = new URLSearchParams({ adressetekst: address, postnummer: postalCode, fuzzy: "false", utkoordsys: "4326", treffPerSide: "2" });
        session.requests++; last = now;

        const response = yield* http.request(SUPPORTED_PROVIDER + "?" + query, { Accept: "application/json" }, 65_536, Math.min(10_000, deadline - now), deadline).pipe(
          Effect.mapError((error) => error.transient
            ? new SourceError({ message: "Official address service is temporarily unavailable", transient: true })
            : new ResolutionError({ message: "Official address lookup failed" })),
        );

        if (response.status !== 200) return yield* transientStatus(response.status)
          ? new SourceError({ message: "Official address service is temporarily unavailable", transient: true })
          : new ResolutionError({ message: "Official address service returned an error" });

        if ((yield* monotonicMillis) >= deadline || response.bytes.length > 65_536) return yield* new ResolutionError({ message: "Address response exceeded bounds" });
        const raw = yield* Effect.try({ try: () => new TextDecoder("utf-8", { fatal: true }).decode(response.bytes), catch: () => new ResolutionError({ message: "Official address lookup failed" }) });
        const decoded = yield* addressJson(raw).pipe(Effect.mapError(() => new ResolutionError({ message: "Official address lookup failed" })));
        const data = yield* decode(OfficialAddressResponse, decoded, "Invalid official address response");
        const count = yield* decode(OfficialAddressMatchCount, data.metadata.totaltAntallTreff, "Invalid official address match count");
        const addresses = data.adresser;

        if (count !== 1n || addresses.length !== 1) return reject("no_unique_match");
        const match = asObject(addresses[0]);

        if (!match) return yield* new ResolutionError({ message: "Invalid official address match" });

        if (!Predicate.isString(match.adressetekst) || normalized(match.adressetekst) !== normalized(address)) return reject("address_mismatch");

        if (match.postnummer !== postalCode) return reject("postcode_mismatch");
        const point = asObject(match.representasjonspunkt);

        if (!point || (point.epsg !== 4326n && point.epsg !== "4326" && point.epsg !== "EPSG:4326")) return reject("unsupported_coordinate_system");
        const lat = point.lat, lon = point.lon;

        if (!((Predicate.isNumber(lat) || Predicate.isBigInt(lat)) && (Predicate.isNumber(lon) || Predicate.isBigInt(lon)))) return reject("invalid_coordinates");
        const a = Number(lat), b = Number(lon);

        if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a) > 90 || Math.abs(b) > 180) return reject("invalid_coordinates");
        const flag = match.stedfestingverifisert ?? null;

        if (flag !== null && !Predicate.isBoolean(flag)) return reject("invalid_verification_flag");
        counts[flag === null ? "not_reported" : flag ? "provider_true" : "provider_false"]++;

        return yield* decode(AddressResolution, { coordinates: [a, b], provider_stedfestingverifisert: flag });
      }),
    };

    yield* decode(AddressSession, session);

    return session;
  }) };
}));

export const resolveCandidates = (sql: SourceSql, nav: NavSession, address: AddressSession, candidates: readonly LocationCandidate[], limit: number, options: ResolutionOptions = {}) => Effect.gen(function* () {
  yield* decode(ResolutionInput.fields.limit, limit, "Limit must be between 1 and 10");
  yield* decode(ResolutionInput, { candidates, limit, options });
  // Exported callers need the same guard before any SQL or external lookup.
  const selectedNow = options.now === undefined ? undefined : yield* timestamp(options.now);
  yield* decode(AddressSession, address);

  if (!(yield* hasTable(sql, "ad_locations"))) return yield* new ResolutionError({ message: "Location storage is missing; rerun with --initialize-location-storage" });
  const hasDetails = yield* hasTable(sql, "ad_detail_versions");

  const current = (id: string) => withReservedConnection(sql, Effect.gen(function* () {
    const ads = yield* sql`SELECT * FROM ads WHERE uuid=${id}`.pipe(Effect.flatMap((rows) => decode(Schema.Array(LocationAdRow), rows)));
    const versions = yield* sql`SELECT changed FROM versions WHERE uuid=${id}`.pipe(Effect.flatMap((rows) => decode(Schema.Array(LocationVersionRow), rows)));
    const details = hasDetails ? yield* sql`SELECT saved_changed, detail_changed FROM ad_detail_versions WHERE uuid=${id}`.pipe(Effect.flatMap((rows) => decode(Schema.Array(LocationDetailRow), rows))) : [];

    return { ad: ads[0], version: versions[0]?.changed, detail: details[0] };
  }));

  const jobs: LocationCandidate[] = [];

  for (const candidate of candidates) {
    const state = yield* current(candidate.uuid);
    const rows = yield* sql`SELECT points, provenance, incomplete FROM ad_locations WHERE uuid=${candidate.uuid}`.pipe(Effect.flatMap((rows) => decode(Schema.Array(StoredLocationRow), rows)));
    const location = rows[0];

    if (state.ad && state.version === state.ad.changed && location) {
      const binding = { provenance: location.provenance, uuid: candidate.uuid, sourceVersion: state.ad.changed, incomplete: location.incomplete, pointsJson: location.points };
      const complete = state.detail ? hasCurrentWorkplaceBinding({ ...binding, currentDetailEvidence: state.detail }) : hasCurrentWorkplaceBinding(binding);

      if (complete) continue;
    }

    jobs.push(candidate);
  }

  jobs.sort((a, b) => codepointOrder(a.uuid, b.uuid));
  const index = jobs.findIndex((job) => job.uuid === options.after);
  const ordered = index < 0 ? jobs : [...jobs.slice(index + 1), ...jobs.slice(0, index + 1)];
  let attempted = 0, resolved = 0, unknown = 0, version_mismatch = 0, unsupported_detail = 0, last_uuid: string | null = options.after ?? null;

  for (const job of ordered.slice(0, limit)) {
    const remaining = 10 - nav.requests - address.requests;

    if (remaining < (nav.token === null ? 2 : 1) || (yield* monotonicMillis) >= Math.min(nav.deadline, address.deadline)) break;
    nav.remaining = remaining;
    const saved = yield* current(job.uuid);
    attempted++; last_uuid = job.uuid;

    if (!saved.ad || saved.version !== saved.ad.changed || (saved.detail && saved.detail.saved_changed !== saved.ad.changed)) {
      unknown++; version_mismatch++;

      if (options.checkpoint) yield* options.checkpoint(job.uuid);
      continue;
    }

    const ad = saved.ad;
    const expected = saved.detail?.detail_changed ?? ad.changed;

    const work = Effect.gen(function* () {
      const [detail] = yield* nav.get("/api/v1/feedentry/" + job.uuid, "detail");
      const now = selectedNow ?? utcText(BigInt(yield* Clock.currentTimeMillis) * 1000n);
      const locations = detail ? matchesDetail(detail, ad, expected, now) : null;

      if (!locations) {
        const content = detail && asObject(detail.ad_content);

        if (!content || !Predicate.isString(content.uuid) || !Predicate.isString(content.updated) || !Predicate.isString(content.title) || !asObject(content.employer) || !Array.isArray(content.workLocations) || Either.isLeft(timestamp(content.updated))) unsupported_detail++;
        else if (Either.isLeft(timestamp(detail?.sistEndret)) || Either.isLeft(timestamp(expected))) unsupported_detail++;
        else if (timestamp(detail?.sistEndret).pipe(Either.getOrNull) !== timestamp(expected).pipe(Either.getOrNull)) version_mismatch++;
        unknown++;

        return;
      }

      const points: (readonly [number, number])[] = [];
      const flags: (boolean | null)[] = [];
      let incomplete = locations.length === 0;

      for (const location of locations) {
        if (10 - nav.requests - address.requests <= 0) { incomplete = true; break; }

        if (!Predicate.isString(location.country) || !norwegianCountries.has(location.country)) { incomplete = true; continue; }

        const found = yield* address.resolve(location.address ?? null, location.postalCode ?? null);

        if (!found) incomplete = true;
        else {
          const verified = yield* decode(AddressResolution, found);
          points.push(verified.coordinates); flags.push(verified.provider_stedfestingverifisert);
        }
      }

      if (!points.length) {
        unknown++;

        return;
      }

      const pointsJson = pointPayloadJson(points);
      const content = asObject(detail?.ad_content)!;
      const retrievedAt = selectedNow ?? utcText(BigInt(yield* Clock.currentTimeMillis) * 1000n);

      // json.dumps(sort_keys=True) spaces must not alter punctuation inside strings.
      const provenance = pythonJson({
        provider: SUPPORTED_PROVIDER, source_version: ad.changed, retrieved_at: retrievedAt,
        method: "exact_unique_address_postcode_epsg4326_approximate", provider_stedfestingverifisert: flags,
        workplace_fingerprint: workplaceBinding({
          digest: fingerprintWorkLocations(content), pointsJson, uuid: job.uuid, sourceVersion: ad.changed,
          detailChanged: expected, detailSavedChanged: saved.detail?.saved_changed ?? null, incomplete,
        }),
      }).replace(/"(?:\\.|[^"\\])*"|[:,]/g, (token) => token === "," || token === ":" ? token + " " : token);

      yield* sql.withTransaction(Effect.gen(function* () {
        const latest = yield* current(job.uuid);

        if (JSON.stringify(latest) !== JSON.stringify(saved)) {
          version_mismatch++;

          return yield* new ResolutionError({ message: "Source changed during location resolution" });
        }

        if (!provenance.trim() || provenance.length > 2000) return yield* new ResolutionError({ message: "Coordinate provenance required" });
        yield* sql`INSERT OR REPLACE INTO ad_locations (uuid, points, incomplete, provenance) VALUES (${job.uuid}, ${pointsJson}, ${incomplete ? 1 : 0}, ${provenance})`;
      }));

      resolved++;
    });

    const outcome = yield* Effect.either(work);

    if (Either.isLeft(outcome)) {
      if (outcome.left instanceof SourceError && outcome.left.transient) return yield* outcome.left;

      if (!(outcome.left instanceof SourceError) && !(outcome.left instanceof ResolutionError)) {
        if (options.checkpoint) yield* options.checkpoint(job.uuid);

        return yield* outcome.left;
      }

      unknown++;
    }

    if (options.checkpoint) yield* options.checkpoint(job.uuid);
  }

  return yield* decode(ResolutionResult, { attempted, resolved, unknown, version_mismatch, unsupported_detail, last_uuid });
});
