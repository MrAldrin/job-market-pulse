import { Effect, Either } from "effect";
import { acquireWorkflowLock } from "../../src/lib/server/orchestration/workflow-locks.ts";

const path = process.argv[2];

if (!path) throw new Error("Missing lock path");

const result = await Effect.runPromise(Effect.either(Effect.scoped(acquireWorkflowLock(path))));

process.exitCode = Either.isRight(result) ? 0 : result.left.code === "busy" ? 75 : 1;
