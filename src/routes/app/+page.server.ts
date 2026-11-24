import { Effect } from "effect";
import { DashboardSnapshot } from "../../lib/server/dashboard/snapshot.ts";
import { runtime } from "../../lib/server/runtime.ts";
import type { PageServerLoad } from "./$types";

// Let the dashboard gate handle both /app and the canonical /app/.
export const trailingSlash = "ignore";

export const load: PageServerLoad = ({ depends, locals }) => {
  depends("pulse:snapshot");

  const capabilities = { canGiveFeedback: locals.canGiveFeedback, canEditSettings: locals.canEditSettings, canRunRefresh: locals.canRunRefresh };

  return runtime.runPromise(Effect.flatMap(DashboardSnapshot, (service) => service.readDocument).pipe(
    Effect.match({
      onFailure: () => ({ snapshot: null, snapshotError: "Could not read the saved snapshot", ...capabilities }),
      onSuccess: (snapshot) => ({ snapshot, snapshotError: null, ...capabilities }),
    }),
  ));
};
