import { Context, Effect, Layer, Schema } from "effect";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { AlertError } from "./errors.ts";

const failure = (code: string) => new AlertError({ code });
const io = <A>(code: string, body: () => Promise<A>) => Effect.tryPromise({ try: body, catch: () => failure(code) });
const missing = Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }));
const collision = Schema.is(Schema.Struct({ code: Schema.Literal("EEXIST") }));

export class AlertArtifacts extends Context.Tag("pulse/AlertArtifacts")<AlertArtifacts, {
  readonly directory: (path: string, create?: boolean, privateLeaf?: boolean) => Effect.Effect<void, AlertError>;
  readonly exists: (path: string) => Effect.Effect<boolean, AlertError>;
  readonly privateFile: (path: string, create?: boolean) => Effect.Effect<void, AlertError>;
  readonly read: (path: string, maximum: number) => Effect.Effect<Uint8Array, AlertError>;
  readonly install: (path: string, content: Uint8Array) => Effect.Effect<void, AlertError>;
}>() {}

// Publish immutable artifacts without replacing an existing file.
export const AlertArtifactsLive = Layer.succeed(AlertArtifacts, AlertArtifacts.of({
  directory: (path, create = false, privateLeaf = true) => io("unsafe_path", async () => {
    if (create) await fs.mkdir(path, { recursive: true, mode: 0o700 });
    const info = await fs.stat(path);

    if (!info.isDirectory() || (privateLeaf && (info.mode & 0o077) !== 0)) throw failure("unsafe_path");
  }),
  exists: (path) => io("artifact_invalid", async () => {
    try {
      await fs.stat(path);

      return true;
    } catch (error) {
      if (missing(error)) return false;
      throw error;
    }
  }),
  privateFile: (path, create = false) => io("unsafe_path", async () => {
    let handle;

    try {
      if (create) {
        try {
          handle = await fs.open(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, 0o600);
          await handle.chmod(0o600);
          await handle.sync();
        } catch (error) {
          if (!collision(error)) throw error;
        }
      }

      handle ??= await fs.open(path, constants.O_RDONLY);
      const info = await handle.stat();

      if (!info.isFile() || (info.mode & 0o777) !== 0o600) throw failure("unsafe_path");
    } finally { await handle?.close(); }
  }),
  read: (path, maximum) => io("artifact_invalid", async () => {
    if (!isAbsolute(path)) throw failure("artifact_invalid");
    const handle = await fs.open(path, constants.O_RDONLY);

    try {
      const info = await handle.stat();

      if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.size > maximum) throw failure("artifact_invalid");
      const bytes = new Uint8Array(maximum + 1);
      let length = 0;

      while (length < bytes.length) {
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);

        if (bytesRead === 0) break;
        length += bytesRead;
      }

      if (length > maximum) throw failure("artifact_invalid");

      return bytes.slice(0, length);
    } finally { await handle.close(); }
  }),
  install: (path, content) => io("artifact_invalid", async () => {
    const equalExisting = async (): Promise<boolean> => {
      let handle;

      try { handle = await fs.open(path, constants.O_RDONLY); }
      catch (error) { if (missing(error)) return false; throw error; }

      try {
        const info = await handle.stat();

        if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.size !== content.byteLength) throw failure("artifact_conflict");
        const bytes = await handle.readFile();

        if (!Buffer.from(content).equals(bytes)) throw failure("artifact_conflict");

        return true;
      } finally { await handle.close(); }
    };

    if (await equalExisting()) return;
    const temporary = join(dirname(path), `.delivery-${randomUUID()}`);
    const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);

    try {
      await handle.chmod(0o600); await handle.writeFile(content); await handle.sync(); await handle.close();

      try { await fs.link(temporary, path); }
      catch (error) {
        if (!collision(error) || !await equalExisting()) throw error;
      }

      const directory = await fs.open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);

      try { await directory.sync(); } finally { await directory.close(); }
    } finally {
      await handle.close().catch(() => undefined);
      await fs.unlink(temporary).catch(() => undefined);
    }
  }),
}));
