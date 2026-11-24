import type { Element } from "@xmldom/xmldom";
import { Clock, Context, Effect, Either, Layer, Schema } from "effect";
import { printable, strip } from "../shared/text.ts";
import { PostcodeAreaError } from "./errors.ts";
import { LookupHttp } from "./lookup-http.ts";
import { APP, SRS, direct, interiorPoint, parseCollection } from "./postcode-geometry.ts";

export const POSTCODE_AREA_ENDPOINT = "https://wfs.geonorge.no/skwms1/wfs.postnummeromrader";

export interface PostcodeArea {
  readonly postcode: string;
  readonly poststed: string;
  readonly latitude: number;
  readonly longitude: number;
}

export const postcodeAreaLabel = (area: PostcodeArea): string => `${area.postcode} ${area.poststed}`;
export const postcodeAreaOriginSource = (_area: PostcodeArea, lookedUp: string): string => `Kartverket Postnummerområder, catalogue-reported CC BY 4.0, EPSG:4326, approximate interior-chord midpoint, looked up ${lookedUp}`;
const failure = () => new PostcodeAreaError({ message: "Postal-area lookup failed" });
const bounds = () => new PostcodeAreaError({ message: "Postal-area lookup exceeded bounds" });

const leadingText = (element: Element | undefined): string => {
  let text = "";

  for (const node of Array.from(element?.childNodes ?? [])) {
    if (node.nodeType === 1) break;

    if (node.nodeType === 3 || node.nodeType === 4) text += node.nodeValue ?? "";
  }

  return text;
};

const decodePostcode = Schema.decodeUnknownEither(Schema.String.pipe(Schema.length(4), Schema.pattern(/^[0-9]{4}$/)));

export class PostcodeAreaTag extends Context.Tag("pulse/PostcodeArea")<PostcodeAreaTag, {
  readonly lookup: (postcode: string) => Effect.Effect<PostcodeArea, PostcodeAreaError>;
}>() {}

export const PostcodeAreaLive = Layer.effect(PostcodeAreaTag, Effect.gen(function* () {
  const http = yield* LookupHttp;

  return {
    lookup: (postcode: string) => Effect.gen(function* () {
      if (Either.isLeft(decodePostcode(postcode))) return yield* new PostcodeAreaError({ message: "Enter a four-digit postcode" });

      const deadline = (yield* Clock.currentTimeNanos) + 10_000_000_000n;

      const remainingTime = Effect.gen(function* () {
        const remaining = deadline - (yield* Clock.currentTimeNanos);

        if (remaining <= 0n) return yield* bounds();

        return Number(remaining) / 1_000_000;
      });

      const filter = `<fes:Filter xmlns:fes="http://www.opengis.net/fes/2.0" xmlns:app="${APP}"><fes:PropertyIsEqualTo><fes:ValueReference>app:postnummerOmrådeId/app:PostnummerområdeId/app:postnummer</fes:ValueReference><fes:Literal>${postcode}</fes:Literal></fes:PropertyIsEqualTo></fes:Filter>`;
      let remainingBytes = 65_536;
      const pages: (readonly Element[])[] = [];

      for (const [count, start] of [[2, undefined], [1, 1]] as const) {
        const parameters = new URLSearchParams({ service: "WFS", version: "2.0.0", request: "GetFeature", typeNames: "app:Postnummerområde", count: String(count), srsName: SRS, outputFormat: "application/gml+xml; version=3.2", filter });

        if (start !== undefined) parameters.set("startIndex", String(start));

        const timeout = yield* remainingTime;
        const raw = yield* http.get(POSTCODE_AREA_ENDPOINT + "?" + parameters, "application/gml+xml", remainingBytes, timeout).pipe(Effect.mapError(failure));
        remainingBytes -= raw.byteLength;

        if (remainingBytes < 0) return yield* bounds();

        yield* remainingTime;
        pages.push(yield* parseCollection(raw));
      }

      const feature = pages[0]?.[0];

      if (pages[0]?.length !== 1 || pages[1]?.length !== 0 || feature === undefined) return yield* failure();

      const identifiers = direct(feature, APP, "postnummerOmrådeId").flatMap((element) => direct(element, APP, "PostnummerområdeId"));
      const identifier = identifiers[0];

      if (identifiers.length !== 1 || identifier === undefined) return yield* failure();

      const codes = direct(identifier, APP, "postnummer");
      const names = direct(identifier, APP, "poststed");
      const name = leadingText(names[0]);

      if (codes.length !== 1 || leadingText(codes[0]) !== postcode || names.length !== 1 || !strip(name) || !printable(name) || Array.from(name).length > 100) return yield* failure();

      const work = interiorPoint(feature);
      let step = work.next();
      let checks = 0;

      while (!step.done) {
        yield* remainingTime;

        // Yield often enough for cancellation without scheduling every ring-pair check.
        if (checks++ % 32 === 0) yield* Effect.yieldNow();

        step = work.next();
      }

      const [longitude, latitude] = yield* step.value;
      yield* remainingTime;

      return { postcode, poststed: strip(name), latitude, longitude };
    }),
  };
}));
