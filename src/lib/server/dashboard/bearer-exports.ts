import { Clock, Effect, Redacted } from "effect";
import { FEEDBACK_EVENTS_PATH } from "../../contracts/feedback-events.ts";
import { readHostedFeedbackEventsResponse } from "../feedback/phone-events.ts";
import { buildStarredJobsResponse } from "../feedback/starred-jobs.ts";
import { readSelectedStars } from "../feedback/starred-reader.ts";
import { readLatestStarredMetadata } from "../snapshot/store.ts";
import { equalBytes } from "./auth.ts";
import type { DashboardSettings } from "./config.ts";
import { jsonResponse, textResponse } from "./response.ts";

const starredPath = "/api/v1/starred-jobs";

type ExportPath = typeof starredPath | typeof FEEDBACK_EVENTS_PATH;

export const isBearerExportPath = (path: string): path is ExportPath => path === starredPath || path === FEEDBACK_EVENTS_PATH;
const bearer = /^Bearer ([A-Za-z0-9_-]{43,256})(?![\s\S])/;
const unexpectedHeaders = ["transfer-encoding", "content-encoding", "expect", "trailer", "content-type"];

// The public contract passes here only after the existing Host gate and never uses browser authorization.
export const bearerExportResponse = (config: DashboardSettings, request: Request, url: URL, path: ExportPath) => Effect.gen(function* () {
  const capability = config.starred;
  const head = request.method === "HEAD";

  if (!capability) return textResponse("Not found", 404, head);

  if (request.method !== "GET") return textResponse("Method not allowed", 405, head);

  const presented = bearer.exec(request.headers.get("authorization") ?? "")?.[1];

  if (!presented || !equalBytes(Buffer.from(presented), Buffer.from(Redacted.value(capability.token)))) {
    return textResponse("Unauthorized", 401);
  }

  const length = request.headers.get("content-length");

  if (url.href !== url.origin + path || request.body !== null || (length !== null && !/^0{1,10}$/.test(length))
    || unexpectedHeaders.some((header) => request.headers.has(header))) return textResponse("Bad request", 400);

  if (path === FEEDBACK_EVENTS_PATH) return jsonResponse(yield* readHostedFeedbackEventsResponse(config.feedbackDb, capability.profileId));

  const stars = yield* readSelectedStars(config.feedbackDb, capability.profileId);
  const snapshot = yield* readLatestStarredMetadata(config.snapshotDb);
  const now = yield* Clock.currentTimeMillis;
  const exportedAt = new Date(now).toISOString().replace(/\.\d{3}Z$/, "+00:00");

  const bytes = yield* buildStarredJobsResponse({
    source_instance: capability.sourceInstance, profile_id: capability.profileId,
    exported_at: exportedAt, snapshot, stars,
  });

  return jsonResponse(bytes);
}).pipe(Effect.catchAllCause(() => Effect.succeed(textResponse("Temporarily unavailable", 503))));
