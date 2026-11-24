import { Option } from "effect";
import { parseIsoTime } from "../lib/contracts/iso-time.ts";

// Local evidence producers use UTC seconds or six fractional digits. Reject
// other spellings rather than printing arbitrary text from a stored field.
export const isProducerUtcTime = (value: string): boolean =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{6})?\+00:00$(?![\s\S])/u.test(value) && Option.isSome(parseIsoTime(value));
