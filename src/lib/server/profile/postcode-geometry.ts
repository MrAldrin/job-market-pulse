import { DOMParser, onErrorStopParsing, type Element } from "@xmldom/xmldom";
import { Either, Schema } from "effect";
import { caseFold, decimalText, strip, words } from "../shared/text.ts";
import { PostcodeAreaError } from "./errors.ts";

export const APP = "http://skjema.geonorge.no/SOSI/produktspesifikasjon/Postnummeromrader/20180215";
export const WFS = "http://www.opengis.net/wfs/2.0";
export const GML = "http://www.opengis.net/gml/3.2";
export const SRS = "urn:ogc:def:crs:EPSG::4326";

export type Point = readonly [number, number]; // Longitude, latitude for planar operations.

type Ring = readonly Point[];

type GeometryWork<T> = Generator<void, Either.Either<T, PostcodeAreaError>, void>;

const invalid = () => Either.left(new PostcodeAreaError({ message: "Invalid postal-area response" }));
export const descendants = (element: Element): Element[] => Array.from(element.getElementsByTagName("*"));
export const children = (element: Element): Element[] => descendants(element).filter((child) => child.parentNode === element);
export const named = (element: Element, namespace: string, local: string): boolean => element.namespaceURI === namespace && element.localName === local;
export const direct = (element: Element, namespace: string, local: string): Element[] => children(element).filter((child) => named(child, namespace, local));

export const parseCollection = (bytes: Uint8Array): Either.Either<readonly Element[], PostcodeAreaError> => Either.gen(function* () {
  const text = yield* Either.try({ try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes), catch: () => new PostcodeAreaError({ message: "Invalid postal-area response" }) });
  // Comments, CDATA and non-declaration processing instructions are not declarations.
  // Detect genuine DTDs before DOM parsing, so internal entities cannot be expanded.
  const syntax = text.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  const declarations = Array.from(syntax.matchAll(/<\?[\s\S]*?\?>/g), (match) => match[0]);

  const encoding = declarations.filter((value) => /^<\?xml\s/.test(value))
    .map((value) => /\bencoding\s*=\s*(["'])(.*?)\1/.exec(value)?.[2]);

  // xmldom reports structural errors, but does not reject all XML 1.0 characters.
  const markup = syntax.replace(/<\?[\s\S]*?\?>/g, "");
  const validXmlCharacter = (code: number): boolean => code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff);
  const invalidReference = Array.from(markup.matchAll(/&#(x[0-9a-fA-F]+|[0-9]+);/g)).some((match) => !validXmlCharacter(match[1]!.startsWith("x") ? Number.parseInt(match[1]!.slice(1), 16) : Number(match[1])));

  if (encoding.some((value) => value !== undefined && caseFold(value) !== "utf-8") || /<!\s*(?:DOCTYPE|ENTITY)\b/i.test(markup) || Array.from(text).some((character) => !validXmlCharacter(character.codePointAt(0)!)) || invalidReference || markup.replace(/<(?:[^"'<>]|"[^"]*"|'[^']*')*>/g, "").includes("]]>")) return yield* invalid();

  // All parser failures, including fatal malformed external input, stay in Either.
  const document = yield* Either.try({
    try: () => new DOMParser({ onError: onErrorStopParsing }).parseFromString(text, "application/xml"),
    catch: () => new PostcodeAreaError({ message: "Invalid postal-area response" }),
  });

  const root = document.documentElement;

  if (root === null || !named(root, WFS, "FeatureCollection")) return yield* invalid();

  for (const element of [root, ...descendants(root)]) {
    if (caseFold(element.localName ?? "") === "next" || caseFold(element.getAttribute("rel") ?? "") === "next") return yield* invalid();

    for (const attribute of Array.from(element.attributes)) {
      if (caseFold(attribute.localName ?? "") === "next" && strip(attribute.value)) return yield* invalid();
    }
  }

  const members = direct(root, WFS, "member");
  const features: Element[] = [];

  for (const member of members) {
    const content = children(member);
    const feature = content[0];

    if (content.length !== 1 || feature === undefined || !named(feature, APP, "Postnummerområde")) return yield* invalid();

    features.push(feature);
  }

  if (descendants(root).filter((element) => named(element, APP, "Postnummerområde")).length !== members.length) return yield* invalid();

  return features;
});

const cross = (a: Point, b: Point, c: Point): number => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const on = (a: Point, b: Point, p: Point): boolean => cross(a, b, p) === 0 && Math.min(a[0], b[0]) <= p[0] && p[0] <= Math.max(a[0], b[0]) && Math.min(a[1], b[1]) <= p[1] && p[1] <= Math.max(a[1], b[1]);
const intersects = (a: Point, b: Point, c: Point, d: Point): boolean => (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) || on(a, b, c) || on(a, b, d) || on(c, d, a) || on(c, d, b);
const segments = (ring: Ring): readonly (readonly [Point, Point])[] => ring.slice(1).map((b, index) => [ring[index]!, b] as const);

const area = (ring: Ring): number => {
  const [x, y] = ring[0]!;

  return Math.abs(segments(ring).reduce((sum, [a, b]) => sum + (a[0] - x) * (b[1] - y) - (b[0] - x) * (a[1] - y), 0)) / 2;
};

const inside = (p: Point, ring: Ring): boolean => {
  let result = false;

  for (const [a, b] of segments(ring)) {
    if (on(a, b, p)) return false;

    if ((a[1] > p[1]) !== (b[1] > p[1]) && a[0] + (p[1] - a[1]) * (b[0] - a[0]) / (b[1] - a[1]) > p[0]) result = !result;
  }

  return result;
};

const coordinate = Schema.String.pipe(Schema.pattern(/^[+-]?(?:[0-9](?:_?[0-9])*(?:\.(?:[0-9](?:_?[0-9])*)?)?|\.[0-9](?:_?[0-9])*)(?:[eE][+-]?[0-9](?:_?[0-9])*)?$/));
const decodeCoordinate = Schema.decodeUnknownEither(coordinate);

const same = (a: Point, b: Point): boolean => a[0] === b[0] && a[1] === b[1];

function* parseRing(element: Element): GeometryWork<Ring> {
  yield;
  const linear = children(element);
  const positions = linear[0] === undefined ? [] : children(linear[0]);
  const pos = positions[0];

  if (linear.length !== 1 || !named(linear[0]!, GML, "LinearRing") || positions.length !== 1 || pos === undefined || !named(pos, GML, "posList") || children(pos).length) return invalid();

  const values = words(pos.textContent ?? "");

  if (values.length % 2 || values.length < 8 || values.length > 5000) return invalid();

  const numbers: number[] = [];

  for (const value of values) {
    // Only frozen Unicode 15.1 decimal digits map to ASCII. Newer JS digits
    // remain unchanged and fail the original float/underscore grammar.
    const mapped = decimalText(value);

    if (Either.isLeft(decodeCoordinate(mapped))) return invalid();

    numbers.push(Number(mapped.replaceAll("_", "")));
  }

  const ring: Point[] = [];

  for (let index = 0; index < numbers.length; index += 2) {
    const latitude = numbers[index]!;
    const longitude = numbers[index + 1]!;

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return invalid();

    ring.push([longitude, latitude]);
  }

  if (!same(ring[0]!, ring[ring.length - 1]!) || area(ring) === 0) return invalid();

  const edges = segments(ring);

  for (const [i, [a, b]] of edges.entries()) {
    const c = edges[(i + 1) % edges.length]![1];

    if (same(a, b) || (cross(a, b, c) === 0 && (on(a, b, c) || on(b, c, a)))) return invalid();

    for (let j = i + 1; j < edges.length; j++) {
      if (j === i + 1 || (i === 0 && j === edges.length - 1)) continue;

      if (j % 32 === 0) yield;

      if (intersects(a, b, ...edges[j]!)) return invalid();
    }
  }

  return Either.right(ring);
}

// Markers match the oracle's budget checks; the core never reads a clock.
export function* interiorPoint(feature: Element): GeometryWork<Point> {
  yield;
  const all = descendants(feature);
  const polygons = all.filter((element) => named(element, GML, "Polygon"));

  for (const property of direct(feature, APP, "område")) {
    const content = children(property);

    if (Array.from(property.attributes).some((attribute) => attribute.namespaceURI !== "http://www.w3.org/2000/xmlns/") || content.length !== 1 || !named(content[0]!, GML, "Polygon")) return invalid();
  }

  if (!polygons.length) return invalid();

  const supported = new Set(["Polygon", "exterior", "interior", "LinearRing", "posList"]);
  const covered = new Set(polygons.flatMap((polygon) => [polygon, ...descendants(polygon)]));

  if (all.some((element) => element.namespaceURI === GML && (!supported.has(element.localName ?? "") || !covered.has(element)))) return invalid();

  let ringsCount = 0;
  let vertices = 0;
  const parsed: Ring[][] = [];

  for (const polygon of polygons) {
    const parent = direct(feature, APP, "område").find((property) => polygon.parentNode === property);

    if (parent === undefined || polygon.getAttribute("srsName") !== SRS) return invalid();

    for (const element of [polygon, ...descendants(polygon)]) {
      if ((element.hasAttribute("srsName") && element.getAttribute("srsName") !== SRS) || (element.hasAttribute("srsDimension") && element.getAttribute("srsDimension") !== "2")) return invalid();
    }

    const boundaries = children(polygon);

    if (!boundaries.length || !named(boundaries[0]!, GML, "exterior") || boundaries.slice(1).some((element) => !named(element, GML, "interior"))) return invalid();

    ringsCount += boundaries.length;

    if (ringsCount > 16) return invalid();

    const rings: Ring[] = [];

    for (const boundary of boundaries) {
      yield;
      const result = yield* parseRing(boundary);

      if (Either.isLeft(result)) return Either.left(result.left);

      vertices += result.right.length;

      if (vertices > 2500) return invalid();

      rings.push(result.right);
    }

    for (const [index, ring] of rings.entries()) {
      for (const other of rings.slice(index + 1)) {
        for (const [a, b] of segments(ring)) {
          for (const [c, d] of segments(other)) {
            yield;

            if (intersects(a, b, c, d)) return invalid();
          }
        }
      }
    }

    for (let index = 1; index < rings.length; index++) {
      const hole = rings[index]!;

      if (!inside(hole[0]!, rings[0]!) || rings.slice(1, index).some((other) => inside(hole[0]!, other) || inside(other[0]!, hole))) return invalid();
    }

    parsed.push(rings);
  }

  parsed.sort((a, b) => area(b[0]!) - area(a[0]!));
  const selected = parsed[0]!;
  const exterior = selected[0]!;

  if (parsed.length > 1 && area(exterior) - area(parsed[1]![0]!) <= 1e-12 * area(exterior)) return invalid();

  const low = Math.min(...exterior.map((point) => point[1]));
  const high = Math.max(...exterior.map((point) => point[1]));

  for (let index = 0; index < 16; index++) {
    yield;
    const y = low + (high - low) * (index + 0.5) / 16;
    const xs = selected.flatMap((ring) => segments(ring).filter(([a, b]) => (a[1] > y) !== (b[1] > y)).map(([a, b]) => a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1]))).sort((a, b) => a - b);
    let chord: readonly [number, number] | undefined;

    for (let i = 0; i + 1 < xs.length; i += 2) {
      const a = xs[i]!;
      const b = xs[i + 1]!;

      if (chord === undefined || b - a > chord[1] - chord[0]) chord = [a, b];
    }

    if (chord === undefined) continue;

    const p: Point = [(chord[0] + chord[1]) / 2, y];

    if (chord[0] < chord[1] && inside(p, exterior) && selected.slice(1).every((hole) => !inside(p, hole) && !segments(hole).some(([a, b]) => on(a, b, p)))) return Either.right(p);
  }

  return invalid();
}
