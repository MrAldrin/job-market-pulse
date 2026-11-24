import { FileSystem } from "@effect/platform";
import { Effect, Either, Option, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join } from "node:path";
import { instant, sourceJson, timestamp, uuid } from "./core.ts";
import { SourceError } from "./errors.ts";
import { sourceState } from "./readers.ts";
import { acquireStore, readSnapshot } from "./store.ts";

const failure = (code: string) => new SourceError({ message: code, code });

export const readLocationCheckpoint = (path: string) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;

  if (!isAbsolute(path)) return yield* failure("location_checkpoint_invalid");

  if (!(yield* fs.exists(path))) return null;
  const info = yield* fs.stat(path);

  if (info.type !== "File" || info.size > 4096n) return yield* failure("location_checkpoint_invalid");
  const bytes = yield* fs.readFile(path);

  if (bytes.length > 4096) return yield* failure("location_checkpoint_invalid");
  const text = yield* Effect.try({ try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes), catch: () => failure("location_checkpoint_invalid") });
  const raw = yield* sourceJson(text);
  const parsed = yield* Schema.decodeUnknown(Schema.Struct({ after: Schema.String }), { onExcessProperty: "error" })(raw);

  return yield* uuid(parsed.after);
}).pipe(Effect.mapError(() => failure("location_checkpoint_invalid")));

export const saveLocationCheckpoint = (path: string, listingId: string) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;

  if (!isAbsolute(path)) return yield* failure("location_checkpoint_invalid");
  yield* uuid(listingId).pipe(Either.mapLeft(() => failure("location_checkpoint_write_failed")));
  const temporary = join(dirname(path), "." + basename(path) + "." + randomUUID().replaceAll("-", "") + ".tmp");

  yield* Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
    // Exclusive creation refuses pre-existing files and symlinks. The outer
    // scope closes the descriptor; cleanup covers write failure/interruption.
    yield* Effect.acquireUseRelease(
      fs.open(temporary, { flag: "wx", mode: 0o600 }),
      (file) => restore(file.writeAll(new TextEncoder().encode(JSON.stringify({ after: listingId }))).pipe(
        Effect.zipRight(file.sync), Effect.zipRight(fs.rename(temporary, path)),
      )),
      () => fs.remove(temporary, { force: true }).pipe(Effect.mapError(() => failure("location_checkpoint_write_failed")), Effect.orDie),
    );
  }));
}).pipe(Effect.scoped, Effect.mapError((error) => error instanceof SourceError ? error : failure("location_checkpoint_write_failed")));

export const sourceCheckFresh = (path: string, now: string, maxAgeMillis: number) => Effect.gen(function* () {
  const current = timestamp(now);

  if (Either.isLeft(current) || !Number.isFinite(maxAgeMillis) || maxAgeMillis < 0) return [false, null] as const;
  const sql = yield* acquireStore(path, "readonly");
  const state = yield* readSnapshot(sql, sourceState(sql));
  const checked = timestamp(state.checked);

  if (Either.isLeft(checked)) return [false, null] as const;
  const checkedAt = instant(checked.right);
  const nowAt = instant(current.right);

  if (Option.isNone(checkedAt) || Option.isNone(nowAt)) return [false, null] as const;
  const age = nowAt.value - checkedAt.value;
  const maxAgeMicros = maxAgeMillis * 1000;

  // A positive overflowed bound exceeds every valid finite timestamp age.
  return [state.caught_up === "1" && age >= 0n && (!Number.isFinite(maxAgeMicros) || age <= BigInt(Math.trunc(maxAgeMicros))), checked.right] as const;
}).pipe(Effect.scoped, Effect.catchAll(() => Effect.succeed([false, null] as const)));
