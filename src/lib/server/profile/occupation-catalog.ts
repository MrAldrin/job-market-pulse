import { Either, Schema } from "effect";
import { decodeStrict, nonemptyText } from "../../contracts/support.ts";
import { normalized } from "../shared/text.ts";
import { parseToml } from "../shared/toml.ts";
import { ProfileError } from "./errors.ts";

const Box = Schema.Struct({ name: nonemptyText, plain: nonemptyText, level2: Schema.Array(nonemptyText) });
const Catalog = Schema.Struct({ source: Schema.optional(Schema.String), retrieved: Schema.optional(Schema.Unknown), level1: Schema.Array(Box).pipe(Schema.minItems(1)) });

export type OccupationBox = typeof Box.Type;

export const decodeCatalog = (text: string): Either.Either<readonly OccupationBox[], ProfileError> => Either.flatMap(parseToml(text), (raw) => {
  const decoded = Either.mapLeft(decodeStrict(Catalog)(raw), () => new ProfileError({ message: "Invalid occupation catalog" }));

  return Either.flatMap(decoded, ({ level1 }) => {
    const names = new Set<string>();

    for (const box of level1) {
      const name = normalized(box.name);

      if (names.has(name) || new Set(box.level2.map(normalized)).size !== box.level2.length) return Either.left(new ProfileError({ message: "Occupation labels must be unique within each level" }));
      names.add(name);
    }

    return Either.right(level1);
  });
});

export const validEntry = (text: string, catalog: readonly OccupationBox[]): boolean => catalog.some((box) => normalized(text) === normalized(box.name) || box.level2.some((child) => normalized(text) === normalized(`${box.name} / ${child}`)));
