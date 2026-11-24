import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import register from "../.pi/extensions/pulse-review.ts";

test("the retired shortcut reports its status without launching a process or echoing arguments", async () => {
  const messages: string[] = [];
  let invoke: (() => Promise<void>) | undefined;
  const host = {
    registerCommand(name, command) {
      expect(name).toBe("pulse-review");
      invoke = () => command.handler("person --all --profile-root PRIVATE_PATH", {
        ui: { notify: (text: string) => messages.push(text) },
      } as Parameters<typeof command.handler>[1]);
    },
    exec() {
      throw new Error("The retired shortcut must not launch a process");
    },
  } satisfies Pick<ExtensionAPI, "registerCommand" | "exec">;

  register(host as ExtensionAPI);
  if (!invoke) throw new Error("Expected the shortcut to register");
  await invoke();

  expect(messages).toEqual(["Standalone Pulse review is not available. No review or refresh was started."]);
});
