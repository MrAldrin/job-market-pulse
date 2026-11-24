import type { Handle, HandleServerError, ServerInit } from "@sveltejs/kit/hooks";
import { Effect } from "effect";
import { runtime } from "./lib/server/runtime.ts";
import { APP_CSP, viewerResponse } from "./lib/server/dashboard/response.ts";
import { DashboardServer } from "./lib/server/dashboard/service.ts";
import { parentPipeKey, watchParentPipe } from "./lib/server/shared/parent-pipe.ts";

export const init: ServerInit = async () => {
  try {
    await runtime.runPromise(DashboardServer);

    // The Bun adapter emits this after draining its HTTP handlers.
    process.once("sveltekit:shutdown", () => {
      void runtime.dispose().catch(() => { console.error("Dashboard shutdown could not release all resources"); });
    });

    if (process.env.PULSE_DASHBOARD_MODE === "local" && process.env[parentPipeKey] === "1") {
      // Let the adapter finish setup and register its shutdown handler first.
      setImmediate(() => { watchParentPipe(process.stdin, () => process.emit("SIGTERM")); });
    }
  } catch {
    // Do not log configuration values or credential-bearing Effect causes.
    throw new Error("Dashboard configuration is invalid; server not started");
  }
};

export const handle: Handle = async ({ event, resolve }) => {
  let gate: Response | undefined;

  try {
    gate = await runtime.runPromise(Effect.gen(function* () {
      const server = yield* DashboardServer;
      // Startup rejects every nonempty ADDRESS_HEADER. With the pinned empty
      // envPrefix, this adapter closure uses the ORIGINAL native Request, even
      // when origin normalization replaced event.request and requestIP is null.
      const address = event.platform?.server.requestIP(event.request)?.address ?? event.getClientAddress() ?? "";
      const kitAppDataSearch = event.isDataRequest && event.route.id === "/app" ? event.url.search : undefined;
      const input = { request: event.request, socketAddress: address, kitAppDataSearch };

      const response = yield* server.handle(input);

      if (response === undefined) Object.assign(event.locals, server.capabilities(input));

      return response;
    }));
  } catch {
    return viewerResponse("Viewer unavailable", 503, "text/plain; charset=utf-8", undefined, event.request.method === "HEAD");
  }

  if (gate) return gate;
  const response = await resolve(event);

  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Content-Type-Options", "nosniff");
  // Kit adds hashes for its own bootstrap. Do not replace that CSP.

  if (!response.headers.has("Content-Security-Policy")) response.headers.set("Content-Security-Policy", APP_CSP);

  return response;
};

export const handleError: HandleServerError = () => ({ message: "Viewer unavailable" });
