import { dashboardSnapshotResponse } from "../../../lib/server/dashboard/snapshot.ts";
import { APP_CSP, viewerResponse } from "../../../lib/server/dashboard/response.ts";
import { runtime } from "../../../lib/server/runtime.ts";
import type { RequestHandler } from "./$types";

export const trailingSlash = "ignore";

const serve: RequestHandler = ({ request, url }) => {
  const head = request.method === "HEAD";

  if (url.pathname !== "/app/snapshot.json" || url.search) return viewerResponse("", 404, undefined, undefined, head, APP_CSP);

  return runtime.runPromise(dashboardSnapshotResponse(head));
};

export const GET = serve;

export const HEAD = serve;
