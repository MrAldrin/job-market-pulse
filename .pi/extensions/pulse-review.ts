import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("pulse-review", {
    description: "Explain why standalone Pulse review is unavailable",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Standalone Pulse review is not available. No review or refresh was started.", "warning");
    },
  });
}
