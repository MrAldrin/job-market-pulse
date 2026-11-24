import { Effect, Either, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { JsonInput, parseJsonInput } from "../../src/lib/server/shared/json-input.ts";
import { LookupHttp } from "../../src/lib/server/profile/lookup-http.ts";
import { parseMatches, PLACE_API, PlaceLookup, PlaceLookupLive, placeOriginSource, POSTCODE_API, populatedKinds } from "../../src/lib/server/profile/place-lookup.ts";

const row = { stedsnummer: 7, navneobjekttype: "by", stedsnavn: [{ skrivemåte: " Invented " }, { skrivemåte: "Ignored spelling" }], kommuner: [{ kommunenavn: "Second" }, { kommunenavn: "First" }, { kommunenavn: "Second" }], fylker: [{ fylkesnavn: "Invented county" }], representasjonspunkt: { koordsys: 4326, nord: 60.0, øst: 10.0 } };
const payload = { metadata: { totaltAntallTreff: 1, utkoordsys: 4326 }, navn: [row] };
const raw = (text: string): JsonInput => Either.getOrThrow(parseJsonInput(text));
const decode = (value: JsonInput) => parseMatches(raw(JSON.stringify(value)));
const match = { name: "Invented", kind: "By", municipality: "First, Second", county: "Invented county", latitude: 60, longitude: 10, place_id: "7" };

const fixture = (responses: readonly string[]) => {
  const calls: string[] = [];

  const http = Layer.succeed(LookupHttp, { get: (url, accept, maximum, timeout) => Effect.sync(() => {
    expect(accept).toBe("application/json");
    expect(maximum).toBe(65_536);
    expect(timeout).toBe(10_000);
    calls.push(url);

    return new TextEncoder().encode(responses[calls.length - 1] ?? "{}");
  }) });

  const search = (query: string, limit = 8) => Effect.gen(function* () {
    const service = yield* PlaceLookup;

    return yield* service.search(query, limit);
  }).pipe(Effect.provide(PlaceLookupLive), Effect.provide(http));

  return { search, calls };
};

describe("bounded locality search", () => {
  it("uses only the first spelling, joins all sorted distinct labels and preserves source identity", () => {
    expect(decode(payload)).toEqual(Either.right([match]));
    expect(placeOriginSource(match, "2026-11-17")).toBe("Kartverket place name 7, EPSG:4326, looked up 2026-11-17");
    expect(decode({ ...payload, navn: [{ ...row, stedsnavn: [row.stedsnavn[0] ?? {}, null] }] })).toEqual(Either.right([match]));
    expect(decode({ ...payload, navn: [{ navneobjekttype: "unpopulated", broken: true }] })).toEqual(Either.right([]));
    expect(decode({ ...payload, navn: [{ ...row, navneobjekttype: "By" }] })).toEqual(Either.right([match]));
  });
  it("deduplicates exact IDs, refuses conflicting IDs and retains arbitrary precision identifiers", () => {
    expect(decode({ ...payload, navn: [row, row] })).toEqual(Either.right([match]));
    expect(Either.isLeft(decode({ ...payload, navn: [row, { ...row, stedsnavn: [{ skrivemåte: "Different" }] }] }))).toBe(true);
    const huge = JSON.stringify(payload).replace('"stedsnummer":7', '"stedsnummer":9007199254740993');
    expect(Either.getOrThrow(parseMatches(raw(huge)))[0]?.place_id).toBe("9007199254740993");
  });
  it.each(["7.0", "7e0", "true", "0", "-1", '"7"'])("refuses a wrong integer token for ID %s", (token) => {
    expect(Either.isLeft(parseMatches(raw(JSON.stringify(payload).replace('"stedsnummer":7', '"stedsnummer":' + token))))).toBe(true);
  });
  it("enforces metadata, label, coordinates, CRS, list types and row bounds", () => {
    for (const value of [{ ...payload, metadata: { totaltAntallTreff: true } }, { ...payload, metadata: { totaltAntallTreff: -1 } }, { ...payload, metadata: {} }, { ...payload, navn: null }, { ...payload, navn: Array.from({ length: 9 }, () => row) }, { ...payload, navn: [{ ...row, stedsnavn: [] }] }, { ...payload, navn: [{ ...row, kommuner: "x" }] }, { ...payload, navn: [{ ...row, stedsnavn: [{ skrivemåte: "bad\nlabel" }] }] }, { ...payload, navn: [{ ...row, representasjonspunkt: { koordsys: 4326, nord: 91, øst: 10 } }] }, { ...payload, navn: [{ ...row, representasjonspunkt: { koordsys: "other", nord: 60, øst: 10 } }] }]) expect(Either.isLeft(decode(value))).toBe(true);

    expect(Either.isLeft(parseMatches(raw(JSON.stringify(payload).replace('"totaltAntallTreff":1', '"totaltAntallTreff":1.0'))))).toBe(true);
    expect(Either.isLeft(parseMatches(raw(JSON.stringify(payload).replaceAll('"koordsys":4326', '"koordsys":4326.0'))))).toBe(true);
    expect(Either.isLeft(parseMatches(raw(JSON.stringify(payload).replace('"utkoordsys":4326', '"utkoordsys":4326.0'))))).toBe(true);
  });
  it("bounds queries and limits before HTTP", async () => {
    const transport = fixture([]);

    for (const query of ["", " ", "x".repeat(101), "bad\nquery", "\ufeffHidden"]) expect(Either.isLeft(await Effect.runPromise(Effect.either(transport.search(query))))).toBe(true);

    for (const limit of [0, 9, 1.5, Number.NaN]) expect(Either.isLeft(await Effect.runPromise(Effect.either(transport.search("Invented", limit))))).toBe(true);

    expect(transport.calls).toEqual([]);
  });
  it("makes one selected name request, or exactly two requests for an ASCII postcode", async () => {
    const name = fixture([JSON.stringify(payload)]);
    expect(await Effect.runPromise(name.search(" Invented ", 3))).toEqual([match]);
    const nameUrl = new URL(name.calls[0] ?? "");
    expect(nameUrl.origin + nameUrl.pathname).toBe(PLACE_API);
    expect(Object.fromEntries(nameUrl.searchParams)).toMatchObject({ sok: "Invented", fuzzy: "false", utkoordsys: "4326", treffPerSide: "3", side: "1" });
    expect(nameUrl.searchParams.getAll("navneobjekttype")).toEqual(Array.from(populatedKinds.keys()));
    const postcode = fixture([JSON.stringify({ metadata: { totaltAntallTreff: 999 }, adresser: [{ postnummer: "0123", poststed: "Invented" }] }), JSON.stringify(payload)]);
    expect(await Effect.runPromise(postcode.search("0123"))).toEqual([match]);
    expect(postcode.calls).toHaveLength(2);
    const first = new URL(postcode.calls[0] ?? "");
    expect(first.origin + first.pathname).toBe(POSTCODE_API);
    expect(Object.fromEntries(first.searchParams)).toMatchObject({ postnummer: "0123", side: "0", treffPerSide: "1" });
    expect(new URL(postcode.calls[1] ?? "").searchParams.get("sok")).toBe("Invented");
  });
  it("returns no matches for an empty postcode page and refuses wrong identity/oversize postal labels", async () => {
    const empty = fixture(['{"metadata":{"totaltAntallTreff":0},"adresser":[]}']);
    expect(await Effect.runPromise(empty.search("0123"))).toEqual([]);
    expect(empty.calls).toHaveLength(1);

    for (const poststed of ["x".repeat(101), "bad\nlabel"]) {
      const transport = fixture([JSON.stringify({ metadata: { totaltAntallTreff: 1 }, adresser: [{ postnummer: "0123", poststed }] })]);
      expect(Either.isLeft(await Effect.runPromise(Effect.either(transport.search("0123"))))).toBe(true);
      expect(transport.calls).toHaveLength(1);
    }

    const wrong = fixture(['{"metadata":{"totaltAntallTreff":1},"adresser":[{"postnummer":"9999","poststed":"Invented"}]}']);
    expect(Either.isLeft(await Effect.runPromise(Effect.either(wrong.search("0123"))))).toBe(true);
    expect(wrong.calls).toHaveLength(1);
  });
});
