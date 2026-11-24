import { Options } from "@effect/cli";
import { Schema } from "effect";

// Effect's text parser can consume a following switch as a value. A path that
// starts like a switch can be written as ./-name rather than as a bare token.
const textValue = Schema.String.pipe(Schema.filter((value) => !(value.startsWith("-") && value.length > 1)));

export const checkoutText = (name: string) => Options.text(name).pipe(Options.withSchema(textValue));

