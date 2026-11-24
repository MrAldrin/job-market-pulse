import { Context, Effect, Either, Layer, Schema } from "effect";
import { finiteNumber } from "../../contracts/support.ts";
import { tomlInteger } from "../../contracts/profile-settings.ts";
import { JsonInput, parseJsonInput } from "../shared/json-input.ts";
import { printable, strip } from "../shared/text.ts";
import { codepointOrder } from "../shared/python-json.ts";
import { PlaceLookupError } from "./errors.ts";
import { decodeLookupText, LookupHttp } from "./lookup-http.ts";

export const PLACE_API = "https://api.kartverket.no/stedsnavn/v1/sted";
export const POSTCODE_API = "https://ws.geonorge.no/adresser/v1/sok";

export const populatedKinds = new Map([
  ["by", "By"], ["tettsted", "Tettsted"], ["grend", "Grend"], ["bygdelagBygd", "Bygdelag (bygd)"],
  ["bydel", "Bydel"], ["administrativBydel", "Administrativ bydel"], ["tettsteddel", "Tettsteddel"], ["kommune", "Kommune"],
]);

const label = Schema.String.pipe(Schema.filter((text) => strip(text).length > 0 && printable(text)));
const crs = Schema.Literal("4326", 4326n);
const totalCount = Schema.BigIntFromSelf.pipe(Schema.greaterThanOrEqualToBigInt(0n));
const Page = Schema.Struct({ metadata: Schema.Struct({ totaltAntallTreff: totalCount, utkoordsys: Schema.optional(crs) }), navn: Schema.Array(JsonInput) });
const Kind = Schema.Struct({ navneobjekttype: Schema.String });

const Row = Schema.Struct({
  stedsnummer: Schema.BigIntFromSelf.pipe(Schema.greaterThanBigInt(0n)), navneobjekttype: Schema.String,
  stedsnavn: Schema.Array(JsonInput).pipe(Schema.minItems(1)),
  kommuner: Schema.Array(Schema.Struct({ kommunenavn: label })), fylker: Schema.Array(Schema.Struct({ fylkesnavn: label })),
  representasjonspunkt: Schema.Struct({ koordsys: crs, nord: Schema.Union(tomlInteger, finiteNumber).pipe(Schema.between(-90, 90)), øst: Schema.Union(tomlInteger, finiteNumber).pipe(Schema.between(-180, 180)) }),
});

export const PlaceMatch = Schema.Struct({ name: label, kind: label, municipality: Schema.String, county: Schema.String, latitude: finiteNumber, longitude: finiteNumber, place_id: Schema.String });

export type PlaceMatch = typeof PlaceMatch.Type;

const failure = () => new PlaceLookupError({ message: "Invalid place response" });
const limitValid = Schema.is(Schema.Int.pipe(Schema.between(1, 8)));
const decodePage = Schema.decodeUnknownEither(Page);
const decodeKind = Schema.decodeUnknownEither(Kind);
const decodeRow = Schema.decodeUnknownEither(Row);
const decodeName = Schema.decodeUnknownEither(Schema.Struct({ skrivemåte: label }));

// Provider payloads intentionally allow unrelated fields, as the Python reader does.
export const parseMatches = (payload: JsonInput, limit = 8): Either.Either<readonly PlaceMatch[], PlaceLookupError> => {
  if (!limitValid(limit)) return Either.left(new PlaceLookupError({ message: "Limit must be between 1 and 8" }));

  return Either.gen(function* () {
    const data = yield* Either.mapLeft(decodePage(payload), failure);

    if (data.navn.length > limit) return yield* Either.left(new PlaceLookupError({ message: "Place response exceeded bounds" }));

    const result: PlaceMatch[] = [];
    const seen = new Map<string, PlaceMatch>();

    for (const value of data.navn) {
      const { navneobjekttype: kind } = yield* Either.mapLeft(decodeKind(value), failure);
      const canonical = populatedKinds.get(kind) ?? (Array.from(populatedKinds.values()).includes(kind) ? kind : undefined);

      if (canonical === undefined) continue;

      const row = yield* Either.mapLeft(decodeRow(value), failure);
      const name = yield* Either.mapLeft(decodeName(row.stedsnavn[0]), failure);

      const match: PlaceMatch = {
        name: strip(name.skrivemåte),
        kind: canonical,
        municipality: Array.from(new Set(row.kommuner.map((item) => strip(item.kommunenavn)))).sort(codepointOrder).join(", "),
        county: Array.from(new Set(row.fylker.map((item) => strip(item.fylkesnavn)))).sort(codepointOrder).join(", "),
        latitude: row.representasjonspunkt.nord, longitude: row.representasjonspunkt.øst, place_id: String(row.stedsnummer),
      };

      const prior = seen.get(match.place_id);

      if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(match)) {
        return yield* Either.left(new PlaceLookupError({ message: "Conflicting place identifier" }));
      }

      if (prior === undefined) {
        result.push(match);
        seen.set(match.place_id, match);
      }
    }

    return result;
  });
};

export const placeOriginSource = (match: PlaceMatch, lookedUp: string): string => `Kartverket place name ${match.place_id}, EPSG:4326, looked up ${lookedUp}`;

const PostcodePage = Schema.Struct({ metadata: Schema.Struct({ totaltAntallTreff: totalCount }), adresser: Schema.Array(Schema.Struct({ postnummer: Schema.String, poststed: label })).pipe(Schema.maxItems(1)) });
const decodePostcode = Schema.decodeUnknownEither(PostcodePage);

export class PlaceLookup extends Context.Tag("pulse/PlaceLookup")<PlaceLookup, {
  readonly search: (query: string, limit?: number) => Effect.Effect<readonly PlaceMatch[], PlaceLookupError>;
}>() {}

export const PlaceLookupLive = Layer.effect(PlaceLookup, Effect.gen(function* () {
  const http = yield* LookupHttp;

  const get = (url: string) => http.get(url, "application/json", 65_536, 10_000).pipe(
    Effect.flatMap(decodeLookupText), Effect.flatMap(parseJsonInput), Effect.mapError(failure),
  );

  return {
    search: (raw: string, limit = 8) => Effect.gen(function* () {
      if (!limitValid(limit)) return yield* new PlaceLookupError({ message: "Limit must be between 1 and 8" });

      if (Array.from(raw).length < 1 || Array.from(raw).length > 100 || !printable(raw) || !strip(raw)) {
        return yield* new PlaceLookupError({ message: "Invalid place query" });
      }

      let query = strip(raw);

      if (/^[0-9]{4}$/.test(query)) {
        const parameters = new URLSearchParams({ postnummer: query, fuzzy: "false", utkoordsys: "4326", treffPerSide: "1", side: "0", filtrer: "metadata,adresser.postnummer,adresser.poststed" });
        const page = yield* get(POSTCODE_API + "?" + parameters).pipe(Effect.flatMap((value) => Either.mapLeft(decodePostcode(value), failure)));
        const row = page.adresser[0];

        if (row === undefined) return [];

        if (row.postnummer !== query || Array.from(strip(row.poststed)).length > 100) return yield* failure();

        query = strip(row.poststed);
      }

      const parameters = new URLSearchParams({ sok: query, fuzzy: "false", utkoordsys: "4326", treffPerSide: String(limit), side: "1", filtrer: "metadata,navn.stedsnummer,navn.navneobjekttype,navn.stedsnavn,navn.kommuner,navn.fylker,navn.representasjonspunkt" });

      for (const kind of populatedKinds.keys()) parameters.append("navneobjekttype", kind);

      return yield* get(PLACE_API + "?" + parameters).pipe(Effect.flatMap((value) => parseMatches(value, limit)));
    }),
  };
}));
