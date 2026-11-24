import { Effect, Schema } from "effect";
import { decodeProfileId } from "../lib/server/profile/core.ts";
import { ProfileFiles } from "../lib/server/profile/files.ts";
import { installationSetting } from "../lib/server/shared/installation-paths.ts";
import { parseToml } from "../lib/server/shared/toml.ts";
import { initPaths } from "./init-state.ts";

const decodeSelector = Schema.decodeUnknownEither(Schema.Struct({ profile: Schema.String }), { onExcessProperty: "error" });

// Explicit selection never inspects the default file. Owning commands validate
// the explicit ID and retain their own unsafe-profile diagnostics.
export const readSelectedProfile = (root: string, explicit: string | undefined) => Effect.gen(function* () {
  if (explicit !== undefined) return explicit;
  const files = yield* ProfileFiles;
  const text = yield* files.read(root, installationSetting(root, initPaths.selector));
  const selector = yield* decodeSelector(yield* parseToml(text));

  return yield* decodeProfileId(selector.profile);
});
