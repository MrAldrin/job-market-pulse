import { DateTime, Either, Option, Schema, flow } from "effect";
import { decodeStrict } from "../../contracts/support.ts";
import { isoEpochMillis, parseIsoTime } from "../../contracts/iso-time.ts";
import { OSLO_ZONE } from "../clock.ts";

const formatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: DateTime.zoneToString(OSLO_ZONE),
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  timeZoneName: "short",
  era: "short",
});

// This presentation boundary accepts arbitrary saved values. Naive, invalid and
// unrepresentable values remain text; the host zone is never inferred.
export const osloTime = flow(decodeStrict(Schema.Unknown), Either.match({
  onLeft: () => "",
  onRight: (value): string => {
    const text = value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : String(value);
    const parsed = parseIsoTime(text);

    if (Option.isNone(parsed) || !parsed.value.aware) {
      return text;
    }

    const parts = Object.fromEntries(formatter.formatToParts(isoEpochMillis(parsed.value)).map((part) => [part.type, part.value]));
    const year = Number(parts.year);

    if (parts.era !== "AD" || year < 1 || year > 9999) {
      return text;
    }

    const zone = parts.timeZoneName === "CEST" || parts.timeZoneName === "GMT+2" ? "CEST"
      : parts.timeZoneName === "CET" || parts.timeZoneName === "GMT+1" ? "CET"
        : parts.timeZoneName === "GMT+0:53:28" ? "LMT" : parts.timeZoneName;

    return `${parts.year?.padStart(4, "0")}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${zone}`;
  },
}));
