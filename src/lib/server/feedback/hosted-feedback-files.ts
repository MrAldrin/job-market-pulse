import { Effect, Schema } from "effect";
import { open, stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { verifyWindowsPrivateFile } from "../shared/windows-private-files.ts";

const missing = Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }));
const unsafe = () => new Error("Invalid private hosted feedback file");

export const hostedFeedbackPath = (path: string) => {
  if (!path || path.split(sep).includes("..")) throw unsafe();

  return resolve(path);
};

export const readHostedFeedbackFile = async (path: string, maximum: number) => {
  const info = await stat(path).catch((error) => {
    if (missing(error)) return null;
    throw error;
  });

  if (!info) return null;

  if (!info.isFile() || info.size > maximum) throw unsafe();

  if (process.platform === "win32") await Effect.runPromise(verifyWindowsPrivateFile(dirname(path), path, true));
  else if ((info.mode & 0o077) !== 0) throw unsafe();

  const file = await open(path, "r");

  try {
    const bytes = Buffer.alloc(info.size + 1);
    let length = 0;

    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);

      if (bytesRead === 0) break;
      length += bytesRead;
    }

    if (length > info.size) throw unsafe();

    return bytes.subarray(0, length);
  } finally { await file.close(); }
};

