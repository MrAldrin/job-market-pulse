import { Clock, Effect, Either, Layer } from "effect";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { LookupHttp } from "../../src/lib/server/profile/lookup-http.ts";
import { PostcodeAreaLive, PostcodeAreaTag, postcodeAreaLabel, postcodeAreaOriginSource, POSTCODE_AREA_ENDPOINT } from "../../src/lib/server/profile/postcode-area.ts";
import { APP, WFS, GML, SRS, parseCollection, interiorPoint } from "../../src/lib/server/profile/postcode-geometry.ts";

const SQUARE = "50 5 50 9 54 9 54 5 50 5";
const ring = (kind: string, coordinates: string): string => `<g:${kind}><g:LinearRing><g:posList>${coordinates}</g:posList></g:LinearRing></g:${kind}>`;
const polygon = (coordinates = SQUARE, holes: readonly string[] = []): string => `<g:Polygon srsName="${SRS}">${ring("exterior", coordinates)}${holes.map((hole) => ring("interior", hole)).join("")}</g:Polygon>`;
const member = (geometry = polygon(), code = "0123", name = "SYNTHETIC"): string => `<w:member><a:Postnummerområde><a:postnummerOmrådeId><a:PostnummerområdeId><a:postnummer>${code}</a:postnummer><a:poststed>${name}</a:poststed></a:PostnummerområdeId></a:postnummerOmrådeId><a:område>${geometry}</a:område></a:Postnummerområde></w:member>`;
const collection = (members = "", attributes = ""): string => `<w:FeatureCollection xmlns:w="${WFS}" xmlns:a="${APP}" xmlns:g="${GML}" numberMatched="unknown" numberReturned="0" ${attributes}>${members}</w:FeatureCollection>`;
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

function fixture(pages: readonly Uint8Array[], advance: () => void = () => {}) {
  const calls: { url: string; accept: string; maximum: number; timeout: number }[] = [];

  const testLayer = Layer.succeed(LookupHttp, {
    get: (url, accept, maximum, timeout) => Effect.sync(() => {
      calls.push({ url, accept, maximum, timeout });
      advance();

      return pages[calls.length - 1] ?? bytes(collection());
    }),
  });

  const lookup = (postcode = "0123") => Effect.gen(function* () {
    const service = yield* PostcodeAreaTag;

    return yield* service.lookup(postcode);
  }).pipe(Effect.provide(PostcodeAreaLive), Effect.provide(testLayer));

  return { calls, lookup };
}

const run = (first: string, second = collection()) => Effect.runPromise(Effect.either(fixture([bytes(first), bytes(second)]).lookup()));
const rejected = async (first: string, second = collection()) => expect(Either.isLeft(await run(first, second))).toBe(true);

const geometryPoint = (geometry: string) => {
  const page = parseCollection(bytes(collection(member(geometry))));

  if (Either.isLeft(page) || page.right[0] === undefined) throw new Error("Invalid test fixture");

  const work = interiorPoint(page.right[0]);
  let step = work.next();
  let markers = 0;

  while (!step.done) {
    markers++;
    step = work.next();
  }

  return { result: step.value, markers };
};

const scriptedClock = (read: () => bigint): Clock.Clock => ({ ...Clock.make(), currentTimeNanos: Effect.sync(read), unsafeCurrentTimeNanos: read });

describe("bounded postal-area lookup", () => {
  test("comments, CDATA and unrelated processing instructions are not declarations", async () => {
    for (const prefix of ['<!-- <!DOCTYPE ignored> -->', '<!-- <?xml version="1.0" encoding="iso-8859-1"?> -->', '<?synthetic <!DOCTYPE ignored> ?>']) {
      expect(Either.isRight(parseCollection(bytes(prefix + collection())))).toBe(true);
      expect(Either.isRight(await run(prefix + collection(member())))).toBe(true);
    }

    expect(Either.isRight(await run(collection('<![CDATA[<!DOCTYPE ignored> <?xml encoding="latin1"?>]]>' + member())))).toBe(true);
    expect(Either.isLeft(parseCollection(bytes('<!DOCTYPE x [<!ENTITY bad "x">]>' + collection())))).toBe(true);
    expect(Either.isLeft(parseCollection(bytes('<?xml version="1.0" encoding="iso-8859-1"?>' + collection())))).toBe(true);
  });
  test.each([0x660, 0x966, 0xff10, 0x1d7ce, 0x1e4f0])("keeps Unicode 15.1 decimal zero U+%s and underscores through geometry and service", async (zero) => {
    const coordinates = SQUARE.replaceAll("50", "5_" + String.fromCodePoint(zero));
    expect(geometryPoint(polygon(coordinates)).result).toEqual(Either.right([7, 50.125]));
    const result = await run(collection(member(polygon(coordinates))));
    expect(Either.isRight(result)).toBe(true);

    if (Either.isRight(result)) expect(result.right).toMatchObject({ longitude: 7, latitude: 50.125 });
  });
  test.each([0x10d40, 0x1e5f0])("rejects post-15.1 decimal zero U+%s through geometry and service", async (zero) => {
    const coordinates = SQUARE.replaceAll("0", String.fromCodePoint(zero));
    expect(Either.isLeft(geometryPoint(polygon(coordinates)).result)).toBe(true);
    await rejected(collection(member(polygon(coordinates))));
  });

  test("actual members override counters, two bounded WFS requests and unchanged source label", async () => {
    const first = bytes(collection(member()));
    const service = fixture([first, bytes(collection())]);
    const result = await Effect.runPromise(service.lookup());

    expect(result).toEqual({ postcode: "0123", poststed: "SYNTHETIC", longitude: 7, latitude: 50.125 });
    expect(postcodeAreaLabel(result)).toBe("0123 SYNTHETIC");
    expect(postcodeAreaOriginSource(result, "2026-11-17")).toBe("Kartverket Postnummerområder, catalogue-reported CC BY 4.0, EPSG:4326, approximate interior-chord midpoint, looked up 2026-11-17");
    expect(service.calls).toHaveLength(2);
    const one = new URL(service.calls[0]!.url);
    const two = new URL(service.calls[1]!.url);

    expect(one.origin + one.pathname).toBe(POSTCODE_AREA_ENDPOINT);
    expect(Object.fromEntries(one.searchParams)).toMatchObject({ service: "WFS", version: "2.0.0", request: "GetFeature", count: "2", typeNames: "app:Postnummerområde", srsName: SRS, outputFormat: "application/gml+xml; version=3.2" });
    expect(one.searchParams.has("startIndex")).toBe(false);
    expect(one.searchParams.get("filter")).toContain("app:postnummerOmrådeId/app:PostnummerområdeId/app:postnummer");
    expect(two.searchParams.get("count")).toBe("1");
    expect(two.searchParams.get("startIndex")).toBe("1");
    expect(service.calls[0]!.accept).toBe("application/gml+xml");
    expect(service.calls[0]!.maximum).toBe(65_536);
    expect(service.calls[1]!.maximum).toBe(65_536 - first.byteLength);
    expect(service.calls[1]!.timeout).toBeGreaterThan(0);
    expect(service.calls[1]!.timeout).toBeLessThanOrEqual(service.calls[0]!.timeout);
  });

  test.each(["123", "12345", "１２３４", " 0123", "0123\n", "abcd"])("invalid query %j never reaches HTTP", async (postcode) => {
    const service = fixture([]);
    const result = await Effect.runPromise(Effect.either(service.lookup(postcode)));

    expect(Either.isLeft(result)).toBe(true);
    expect(service.calls).toHaveLength(0);
  });

  test("missing, duplicate and second-page members fail closed; identity is exact", async () => {
    await rejected(collection());
    await rejected(collection(member() + member()));
    await rejected(collection(member()), collection(member()));
    await rejected(collection(member(polygon(), "9999")));
    await rejected(collection(member(polygon(), "0123", "")));
    await rejected(collection(member(polygon(), "0123", "BAD&#10;NAME")));
    await rejected(collection(member(polygon(), "0123", "X".repeat(101))));
    await rejected(collection(member().replace("<a:postnummer>0123</a:postnummer>", "<a:postnummer>0123</a:postnummer><a:postnummer>0123</a:postnummer>")));
  });

  test.each([
    'next="https://example.invalid"', 'xmlns:x="urn:x" x:next="page"',
  ])("pagination attributes %s are rejected anywhere", async (attributes) => {
    await rejected(collection(member(), attributes));
    await rejected(collection(member().replace("<a:poststed>", `<a:poststed ${attributes}>`)));
  });

  test("pagination elements and rel markers, nested members and wrong namespaces are rejected", async () => {
    await rejected(collection(member() + "<w:next/>"));
    await rejected(collection(member() + '<w:link rel="NEXT"/>'));
    await rejected(collection(`<a:wrapper>${member()}</a:wrapper>`));
    await rejected(collection(member()).replace(APP, "urn:fake"));
    await rejected(collection(member()).replace(WFS, "urn:fake"));
  });

  test.each([
    "not XML", "<w:FeatureCollection>", collection(member()).replace("</g:Polygon>", "</g:Point>"),
    collection(member()).replace("SYNTHETIC", "&missing;"),
    collection(member()) + "\u0001", collection(member()).replace("SYNTHETIC", "&#0;"),
    collection(member()).replace("SYNTHETIC", "&#xD800;"), collection(member()).replace("SYNTHETIC", "]]>"),
    '<!DOCTYPE w:FeatureCollection [<!ENTITY x "EXPAND">]>' + collection(member()),
    '<?xml version="1.0" encoding="iso-8859-1"?>' + collection(member()),
    '<?xml version="1.0" encoding="utf-16"?>' + collection(member()),
  ])("malformed or unsafe XML fails: %s", async (xml) => {
    await rejected(xml);
  });

  test("namespace declarations are not geometry attributes; text and CDATA identity are exact", async () => {
    const payload = member().replace("<a:område>", `<a:område xmlns:g="${GML}">`).replace("SYNTHETIC", "<!--identity--><![CDATA[SYN]]>THETIC");
    const result = await run(collection(payload, 'note="]]>"'));

    expect(Either.isRight(result)).toBe(true);

    if (Either.isRight(result)) expect(result.right.poststed).toBe("SYNTHETIC");
  });

  test("fatal UTF-8 decoding and aggregate byte bound", async () => {
    const invalidUtf8 = fixture([new Uint8Array([0xff])]);

    expect(Either.isLeft(await Effect.runPromise(Effect.either(invalidUtf8.lookup())))).toBe(true);
    const service = fixture([bytes(collection(member())), bytes(collection().padEnd(65_536, " "))]);

    expect(Either.isLeft(await Effect.runPromise(Effect.either(service.lookup())))).toBe(true);
  });

  test("one deadline covers transport, refuses the second request, and shrinks its timeout", async () => {
    let now = 0n;
    const clock = scriptedClock(() => now);
    const slow = fixture([bytes(collection(member()))], () => { now += 11_000_000_000n; });
    const result = await Effect.runPromise(Effect.either(slow.lookup().pipe(Effect.withClock(clock))));

    expect(Either.isLeft(result)).toBe(true);
    expect(slow.calls).toHaveLength(1);
    now = 0n;
    const bounded = fixture([bytes(collection(member())), bytes(collection())], () => { now += 2_000_000_000n; });

    await Effect.runPromise(bounded.lookup().pipe(Effect.withClock(clock)));
    expect(bounded.calls.map((call) => call.timeout)).toEqual([10_000, 8_000]);
  });

  test("monotonic deadline interrupts geometry at a generator budget marker", async () => {
    let reads = 0;
    const clock = scriptedClock(() => ++reads < 15 ? 0n : 10_000_000_000n);
    const service = fixture([bytes(collection(member(polygon(SQUARE, ["51 6 51 8 53 8 53 6 51 6"])))), bytes(collection())]);
    const result = await Effect.runPromise(Effect.either(service.lookup().pipe(Effect.withClock(clock))));

    expect(Either.isLeft(result)).toBe(true);
    expect(service.calls).toHaveLength(2);
    expect(reads).toBe(15);

    if (Either.isLeft(result)) expect(result.left.message).toContain("bounds");
  });
});

describe("verified interior chords without fallback", () => {
  test("rectangle chords preserve longitude/latitude and the first fixed scan", () => {
    fc.assert(fc.property(fc.integer({ min: -100, max: 100 }), fc.integer({ min: -60, max: 60 }), fc.integer({ min: 1, max: 10 }), fc.integer({ min: 1, max: 10 }), (west, south, width, height) => {
      const coordinates = `${south} ${west} ${south} ${west + width} ${south + height} ${west + width} ${south + height} ${west} ${south} ${west}`;

      expect(geometryPoint(polygon(coordinates)).result).toEqual(Either.right([west + width / 2, south + height / 32]));
    }), { numRuns: 50 });
  });

  test("Python float decimal Unicode digits and digit separators remain accepted", () => {
    expect(geometryPoint(polygon("5_0 ٥ 5_0 ٩ 54 ٩ 54 ٥ 5_0 ٥")).result).toEqual(Either.right([7, 50.125]));
  });

  test("hole exclusion, leftmost equal-width chord, concavity, largest exterior", () => {
    const hole = "50.01 5.1 50.01 8.9 53.99 8.9 53.99 5.1 50.01 5.1";
    const holed = geometryPoint(polygon(SQUARE, [hole]));

    expect(holed.result).toEqual(Either.right([5.05, 50.125]));
    expect(holed.markers).toBeGreaterThan(20);
    expect(geometryPoint(polygon("50 5 50 9 51 9 51 6 53 6 53 9 54 9 54 5 50 5")).result).toEqual(Either.right([7, 50.125]));
    expect(geometryPoint(polygon() + "</a:område><a:område>" + polygon("60 10 60 11 61 11 61 10 60 10")).result).toEqual(Either.right([7, 50.125]));
  });

  test.each([
    polygon() + "</a:område><a:område>" + polygon(),
    polygon() + "</a:område><a:område>" + polygon("60 5 60 9 64 9 64 5.000000000001 60 5"),
    polygon().replace(SRS, "EPSG:4326"),
    polygon().replace("<g:LinearRing>", '<g:LinearRing srsName="EPSG:3857">'),
    polygon().replace("<g:posList>", '<g:posList srsDimension="3">'),
    polygon().replaceAll("g:posList", "g:pos"),
    `<g:MultiSurface>${polygon()}</g:MultiSurface>`,
    `<a:other>${polygon()}</a:other>`, polygon() + polygon(),
    polygon("50 5 50 9 54 9 54 5"), polygon("50 5 50 5 50 5 50 5"),
    polygon("50 5 54 9 50 9 54 5 50 5"), polygon("50 5 54 9 50 9 53 5 50 5"), polygon("50 5 50 nan 54 9 54 5 50 5"),
    polygon("50 5 50 1e999 54 9 54 5 50 5"), polygon("100 5 100 9 104 9 104 5 100 5"),
    polygon("50 5 50 9 50 7 54 9 54 5 50 5"),
    polygon(SQUARE, ["55 6 55 7 56 7 56 6 55 6"]),
    polygon(SQUARE, ["50 6 50 7 51 7 51 6 50 6"]),
    polygon(SQUARE, ["51 6 51 8 53 8 53 6 51 6", "51.5 6.5 51.5 7 52 7 52 6.5 51.5 6.5"]),
    polygon(SQUARE, Array.from({ length: 16 }, () => SQUARE)),
    polygon(Array.from({ length: 2501 }, () => "50 5").join(" ")),
  ])("rejects unsupported, ambiguous or invalid geometry %s", (geometry) => {
    expect(Either.isLeft(geometryPoint(geometry).result)).toBe(true);
  });

  test.each([
    '<a:område xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="#external"/>',
    "<a:område/>", "<a:område><a:other/></a:område>",
  ])("an additional unsupported geometry property never gets ignored", async (property) => {
    await rejected(collection(member().replace("</a:Postnummerområde>", property + "</a:Postnummerområde>")));
  });
});
