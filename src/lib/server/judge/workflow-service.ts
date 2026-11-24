import { Context, Effect, type Scope } from "effect";
import { join } from "node:path";
import { openJudgeDatabase } from "./database.ts";
import { createReviewSession, prepareReviewSession } from "./workflow-controller.ts";
import { WorkflowError } from "./workflow-errors.ts";

// The caller supplies an actual interprocess lock. There is no unlocked layer.
export class ReviewProfileLock extends Context.Tag("pulse/ReviewProfileLock")<ReviewProfileLock, {
  readonly acquire: (path: string) => Effect.Effect<void, WorkflowError, Scope.Scope>;
}>() {}

type ControllerOptions = Parameters<typeof createReviewSession>[0];

export type ReviewSessionOptions = Omit<ControllerOptions, "store">;

/** Keep the profile lock and database alive for the whole callback, including interruption. */
export const withReviewSession = <A, E, R>(options: ReviewSessionOptions, use: (session: Effect.Effect.Success<ReturnType<typeof createReviewSession>>, store: Effect.Effect.Success<ReturnType<typeof openJudgeDatabase>>) => Effect.Effect<A, E, R>) => Effect.scoped(Effect.gen(function* () {
  const { listingIds } = yield* prepareReviewSession(options);

  const lock = yield* ReviewProfileLock;
  yield* lock.acquire(join(options.context.profile.paths.directory, ".personal-review.lock"));
  const profile = options.context.profile;

  const store = yield* openJudgeDatabase({ profile_id: profile.profile_id, directory: profile.paths.directory, path: profile.paths.review_db, readonly: false, require_existing: false }).pipe(
    Effect.mapError(() => new WorkflowError({ code: "review_db_unavailable" })),
  );

  const session = yield* createReviewSession({ ...options, listingIds, store });

  return yield* use(session, store);
}));
