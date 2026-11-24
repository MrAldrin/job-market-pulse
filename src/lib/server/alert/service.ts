import { Context, Effect, Exit, Layer, Option, Redacted, type Scope } from "effect";
import { join, resolve } from "node:path";
import type { DispatchApprovalSummary, DispatchResult, ReadOnlyDigest } from "../../contracts/alert.ts";
import type { ProfileBundle } from "../../contracts/profile.ts";
import { AlertArtifacts } from "./artifacts.ts";
import { checkProfile } from "./config.ts";
import { sha256 } from "./core.ts";
import { DiscordTransport, endpoint, validPreview, type DestinationConfig } from "./discord.ts";
import { AlertError } from "./errors.ts";
import type { DeliveryOutboxService } from "./outbox.ts";

// B11 supplies the canonical scoped inter-process .stage.lock. No unlocked default.
export class AlertProfileLock extends Context.Tag("pulse/AlertProfileLock")<AlertProfileLock, {
  readonly acquire: (path: string) => Effect.Effect<void, AlertError, Scope.Scope>;
}>() {}

const fail = (code: string) => new AlertError({ code });

const destinationFingerprint = (config: DestinationConfig) => sha256(JSON.stringify({
  channel: config.channel, destination: Redacted.value(config.destination), sender_key_header: null, smtp: null, webhook_preset: null,
}));

export const confirmationText = (summary: DispatchApprovalSummary): string => {
  const canonical = JSON.stringify({
    artifact_fingerprint: summary.artifact_fingerprint, channel: summary.channel, destination_fingerprint: summary.destination_fingerprint,
    digest_key_fingerprint: summary.digest_key_fingerprint, payload_fingerprint: summary.payload_fingerprint,
    profile_id: summary.profile_id, sensitivity: summary.sensitivity, status: summary.status,
  });

  return "SEND " + sha256(canonical);
};

export const makeAlertDispatch = (profile: ProfileBundle, outbox: DeliveryOutboxService) => Effect.gen(function* () {
  const files = yield* AlertArtifacts;
  const transport = yield* DiscordTransport;

  const prepare = (key: string, config: DestinationConfig) => Effect.gen(function* () {
    yield* checkProfile(profile).pipe(Effect.provideService(AlertArtifacts, files));

    if (config.profile_id !== profile.profile_id || outbox.storageRoot !== resolve(profile.paths.outbox_dir)
      || outbox.databasePath !== resolve(profile.paths.ledger_db)) return yield* fail("profile_mismatch");

    if (config.channel !== "redacted_discord" || !["local_only", "environment"].includes(config.source)
      || !endpoint(Redacted.value(config.destination))) return yield* fail("config_invalid");
    const snapshot = yield* outbox.readDigest(key);

    if (snapshot.staged.status !== "staged" && snapshot.staged.status !== "failed") return yield* fail("digest_not_dispatchable");
    yield* files.directory(outbox.artifactsDirectory);
    const content = yield* files.read(snapshot.staged.push_preview_path, 2 * 1024 * 1024);
    const payload = { content, content_type: "application/json", filename: "push-preview.json" } as const;

    if (!validPreview(payload)) return yield* fail("artifact_invalid");

    const summary: DispatchApprovalSummary = {
      profile_id: profile.profile_id, digest_key_fingerprint: sha256(key), status: snapshot.staged.status,
      channel: "redacted_discord", sensitivity: "redacted_preview", payload_fingerprint: snapshot.payload_hash,
      artifact_fingerprint: sha256(content), destination_fingerprint: destinationFingerprint(config),
    };

    return { snapshot, payload, summary, config };
  });

  const sendClaimed = (key: string, prepared: { readonly snapshot: ReadOnlyDigest; readonly payload: Parameters<typeof transport.send>[1]; readonly config: DestinationConfig }) => Effect.gen(function* () {
    const result = yield* transport.send(prepared.config, prepared.payload).pipe(Effect.exit);
    const base = { profile_id: profile.profile_id, digest_key: key, channel: "redacted_discord" } as const;

    if (Exit.isFailure(result)) return { ...base, status: "uncertain", diagnostic_code: "transport_exception" } satisfies DispatchResult;

    if (result.value === "accepted" || result.value === "rejected") {
      const status = result.value === "accepted" ? "delivered" : "failed";

      yield* outbox.mark(key, status, status === "delivered").pipe(Effect.mapError(() => fail("ledger_update_failed")));

      return { ...base, status, diagnostic_code: status === "failed" ? "transport_rejected" : null } satisfies DispatchResult;
    }

    return { ...base, status: "uncertain", diagnostic_code: null } satisfies DispatchResult;
  });

  const approved = (key: string, config: DestinationConfig, approve: (summary: DispatchApprovalSummary) => Effect.Effect<boolean, AlertError>, reload?: Effect.Effect<DestinationConfig, AlertError>) => Effect.gen(function* () {
    const initial = yield* prepare(key, config);
    const accepted = yield* approve(initial.summary);

    if (!accepted) return yield* fail("approval_declined");

    return yield* Effect.scoped(Effect.gen(function* () {
      const lock = yield* Effect.serviceOption(AlertProfileLock);

      if (Option.isNone(lock)) return yield* fail("profile_lock_unavailable");
      yield* lock.value.acquire(join(profile.paths.directory, ".stage.lock"));
      const current = yield* prepare(key, reload ? yield* reload : config);

      if (JSON.stringify(initial.summary) !== JSON.stringify(current.summary)
        || Redacted.value(initial.config.destination) !== Redacted.value(current.config.destination)
        || initial.config.source !== current.config.source) return yield* fail("preflight_changed");
      yield* outbox.claim(key, { status: current.snapshot.staged.status, payload_hash: current.snapshot.payload_hash, items: current.snapshot.items })
        .pipe(Effect.mapError(() => fail("preflight_changed")));

      return yield* sendClaimed(key, current);
    }));
  });

  return {
    preflight: (key: string, config: DestinationConfig) => prepare(key, config).pipe(Effect.map((prepared) => prepared.summary)),
    dispatchApproved: approved,
    // Explicit low-level API retained for trusted composition and frozen recorded cases.
    dispatch: (key: string, config: DestinationConfig) => approved(key, config, () => Effect.succeed(true)),
  };
});

export type AlertDispatchService = Effect.Effect.Success<ReturnType<typeof makeAlertDispatch>>;

export class AlertDispatch extends Context.Tag("pulse/AlertDispatch")<AlertDispatch, AlertDispatchService>() {}

export const AlertDispatchLive = (profile: ProfileBundle, outbox: DeliveryOutboxService) => Layer.effect(AlertDispatch, makeAlertDispatch(profile, outbox));
