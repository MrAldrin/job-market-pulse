import { FileSystem } from "@effect/platform";
import { ntfySettingsPath } from "../profile/ntfy-settings.ts";
import { installationSetting } from "../shared/installation-paths.ts";
import { Clock, Context, Effect, Either, Layer } from "effect";
import { dirname, join, resolve } from "node:path";
import type { ProfileBundle } from "../../contracts/profile.ts";
import type { SnapshotDocument } from "../../contracts/snapshot.ts";
import { PhoneShortlist, PhoneShortlistLive, SavedReviewResource } from "../select/phone-shortlist.ts";
import { INTEREST_PATTERNS_PATH } from "../filter/evidence-pack.ts";
import { readBoundedFile } from "../shared/bounded-file.ts";
import { noDigestPage, safeDigestPage } from "./capture-core.ts";
import { SnapshotError } from "./errors.ts";
import { SnapshotJsonFile } from "./json-file.ts";
import { SnapshotPaths, type ProtectedSnapshotInput } from "./paths.ts";
import { SnapshotExport, SnapshotFacts, type SnapshotBuildOptions } from "./service.ts";
import { snapshotJsonBytes } from "./serialization.ts";
import { SnapshotStore, type ShortlistMetadata, type StarredMetadata } from "./store.ts";

export type SnapshotDigestInput = { readonly kind: "none" } | { readonly kind: "html"; readonly path: string } | { readonly kind: "store"; readonly path: string };

export interface SnapshotCaptureOptions extends SnapshotBuildOptions {
  readonly digest: SnapshotDigestInput;
  readonly keep?: number;
  readonly shortlist?: boolean;
  readonly companionJson?: string;
  readonly protectedInputs?: readonly ProtectedSnapshotInput[];
}

export interface SnapshotCaptureResult {
  readonly rowId: number;
  readonly legacyAssumption: boolean;
  readonly digestWarning: string | null;
  readonly jsonWarning: string | null;
  readonly document: SnapshotDocument;
}

export class SnapshotCapture extends Context.Tag("pulse/SnapshotCapture")<SnapshotCapture, {
  readonly capture: (profile: ProfileBundle, output: string, options: SnapshotCaptureOptions) => Effect.Effect<SnapshotCaptureResult, SnapshotError>;
}>() {}

export const SnapshotCaptureLive = Layer.effect(SnapshotCapture, Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* SnapshotPaths;
  const exporter = yield* SnapshotExport;
  const store = yield* SnapshotStore;
  const jsonFile = yield* SnapshotJsonFile;
  const facts = yield* SnapshotFacts;

  return SnapshotCapture.of({
    capture: (profile, outputPath, options) => Effect.scoped(Effect.gen(function* () {
      const keep = options.keep ?? 10;

      if (!Number.isSafeInteger(keep) || keep < 1) return yield* new SnapshotError({ message: "keep must be a positive integer" });
      const now = options.now ?? new Date(yield* Clock.currentTimeMillis).toISOString();
      const root = resolve(profile.paths.directory, "../../..");
      const frozenMarketPath = options.frozenMarketPath === undefined ? join(root, "data/market.sqlite3") : options.frozenMarketPath;

      const protectedInputs: ProtectedSnapshotInput[] = [
        ...[profile.paths.source_db, profile.paths.review_db, profile.paths.ledger_db, join(root, "data/review.sqlite3"), join(profile.paths.directory, "market-snapshots.sqlite3"), options.frozenMarketPath ?? join(root, "data/market.sqlite3")].map((path) => ({ path, database: true })),
        ...[profile.paths.profile_file, profile.paths.narrative_file, profile.paths.preferences_file, ...["filters.toml", "screen.toml", "judge.toml"].map((name) => join(profile.paths.directory, name)), installationSetting(root, "local_only/config/market_taxonomy.toml"), installationSetting(root, INTEREST_PATTERNS_PATH), ntfySettingsPath(root)].map((path) => ({ path, database: false })),
        ...(options.protectedInputs ?? []),
      ];

      if (options.digest.kind !== "none") protectedInputs.push({ path: options.digest.path, database: options.digest.kind === "store" });
      const output = yield* paths.output(outputPath, protectedInputs);
      const document = yield* exporter.build(profile, { ...options, now });
      let page: Uint8Array = noDigestPage();
      let legacyAssumption = false;
      let digestWarning: string | null = null;

      if (options.digest.kind !== "none") {
        const digest = options.digest;

        const html = digest.kind === "html"
          ? yield* readBoundedFile(digest.path, 2_000_000).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.mapError(() => new SnapshotError({ message: "Cannot read digest HTML" })))
          : yield* store.latest(digest.path).pipe(Effect.flatMap((record) => {
            if (record === null) return Effect.fail(new SnapshotError({ message: "Digest database has no published snapshot" }));
            legacyAssumption = record.dashboardJson === null && record.dashboardBundle === null;

            return Effect.succeed(record.html);
          }));

        yield* Effect.try({ try: () => new TextDecoder("utf-8", { fatal: true }).decode(html), catch: () => new SnapshotError({ message: "Digest HTML is not valid UTF-8" }) });
        const input = yield* facts.load(profile, now, frozenMarketPath);

        if (!input.funnel.verified) return yield* new SnapshotError({ message: "Cannot read reviewed-jobs funnel" });
        const safe = safeDigestPage(html, input.funnel.listingIds);
        page = safe.html;
        digestWarning = safe.warning;
      }

      let shortlist: ShortlistMetadata | null = null;
      let starred: StarredMetadata | null = null;

      if (options.shortlist) {
        const input = yield* facts.load(profile, now, frozenMarketPath);

        const resource = Layer.succeed(SavedReviewResource, { read: Effect.succeed({
          verified: input.funnel.verified, listingIds: [...input.funnel.listingIds],
          candidates: [...input.judge.ranked, ...input.judge.closed], firstFound: input.judge.firstFound,
        }) });

        const captured = yield* Effect.flatMap(PhoneShortlist, (phone) => phone.capture(profile.profile_id, profile.policy.mode, new Date(now))).pipe(
          Effect.provide(PhoneShortlistLive.pipe(Layer.provide(resource))),
          Effect.mapError(() => new SnapshotError({ message: "Cannot capture saved shortlist" })),
        );

        page = captured.html;
        // Canonical renderer emits this exact card marker; user text is escaped.
        const listing_ids = [...new TextDecoder().decode(page).matchAll(/<article class="job is-new" data-job="([a-z0-9_-]{1,128})">/g)].map((match) => match[1]!);
        shortlist = { profile_id: profile.profile_id, listing_ids };
        starred = { schema_version: 1, ...captured.metadata };
        digestWarning = null;
      }

      yield* fs.makeDirectory(dirname(output), { recursive: true, mode: 0o700 }).pipe(Effect.mapError(() => new SnapshotError({ message: "Cannot create snapshot directory" })));
      const exists = yield* fs.exists(output).pipe(Effect.mapError(() => new SnapshotError({ message: "Cannot inspect snapshot output" })));
      const writePath = exists ? output : yield* fs.makeTempFileScoped({ directory: dirname(output), prefix: ".snapshot-store-" }).pipe(Effect.mapError(() => new SnapshotError({ message: "Cannot create private snapshot sibling" })));

      if (!exists) yield* fs.chmod(writePath, 0o600).pipe(Effect.mapError(() => new SnapshotError({ message: "Cannot set private snapshot permissions" })));
      const rowId = yield* store.publish(writePath, { html: page, dashboardJson: snapshotJsonBytes(document), shortlist, starred, keep });
      yield* fs.chmod(writePath, 0o600).pipe(Effect.mapError(() => new SnapshotError({ message: "Cannot set private snapshot permissions" })));

      if (!exists) yield* fs.link(writePath, output).pipe(Effect.mapError(() => new SnapshotError({ message: "Cannot publish snapshot without overwriting a new destination" })));
      let jsonWarning: string | null = null;

      if (options.companionJson !== undefined) {
        const written = yield* paths.output(options.companionJson, [...protectedInputs, { path: output, database: true }]).pipe(
          Effect.flatMap((path) => jsonFile.write(path, document)), Effect.either,
        );

        if (Either.isLeft(written)) jsonWarning = "Snapshot captured, but companion JSON export failed; an older JSON file may remain.";
      }

      return { rowId, legacyAssumption, digestWarning, jsonWarning, document };
    })), 
  });
}));
