import { Either } from "effect";
import { parse, stringify, type TomlTable } from "smol-toml";
import { ProfileError } from "../profile/errors.ts";

// The same small dependency writes TOML and retains int/float types at parse boundaries.
// Bun's parser erases that distinction (5.0 must not become an integer-only batch size).
export const parseToml = (text: string): Either.Either<TomlTable, ProfileError> => Either.try({
  try: () => parse(text, { integersAsBigInt: true }),
  catch: () => new ProfileError({ message: "Cannot read valid settings TOML" }),
});

export const writeToml = (table: TomlTable): Either.Either<string, ProfileError> => Either.try({
  try: () => stringify(table, { numbersAsFloat: true }),
  catch: () => new ProfileError({ message: "Cannot serialize settings TOML" }),
});
