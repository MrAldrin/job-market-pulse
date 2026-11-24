import { Effect } from "effect";
import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { setupPlanLines, setupSummary } from "../../src/cli/init-output.ts";
import { isInitTomlTable, type InitSelectedSnapshot } from "../../src/cli/init-state.ts";
import { maxInterviewContextBytes } from "../../src/cli/interview-session.ts";
import { parseToml } from "../../src/lib/server/shared/toml.ts";
import expected from "../oracle/setup-interview/cli/init.json";

const files = new URL("../oracle/setup-interview/setup/files/", import.meta.url);

test("the frozen choices produce the exact summary slice without rendering a draft", async () => {
  const checkpoint = await readFile(new URL("init-answers.toml", files), "utf8");
  const configText = await readFile(new URL("profiles/invented/profile.toml", files), "utf8");
  const { answers } = await Effect.runPromise(parseToml(checkpoint));

  if (!isInitTomlTable(answers)) throw new Error("Invalid frozen setup answers");

  const lines = await Effect.runPromise(setupSummary({ answers, configText, originalNarrative: null, dryRun: false }));
  const start = expected.stdout.indexOf("7/7  Summary\n") + "7/7  Summary\n".length;
  const end = expected.stdout.indexOf("Planned files:", start);

  expect(lines.join("\n") + "\n").toBe(expected.stdout.slice(start, end));
});

test("kept narrative is neither printed nor called complete after a size or decode failure", async () => {
  const answers = { profile_id: "invented", interview: "kept", origin_latitude: 60, origin_longitude: 10 };
  const summarize = (originalNarrative: InitSelectedSnapshot) => Effect.runPromise(setupSummary({ answers, configText: undefined, originalNarrative, dryRun: true }));

  const large = await summarize({ mode: 0o600, digest: "not-shown" });
  const overLimit = await summarize({ mode: 0o600, bytes: new Uint8Array(maxInterviewContextBytes + 1).fill(0x61) });
  const bad = await summarize({ mode: 0o600, bytes: Uint8Array.of(0xff, 0xfe) });

  expect(large).toContain("Profile text: Retained; NOT CHECKED (interview/summary size limit)");
  expect(bad).toContain("Profile text: Retained; incomplete");
  expect(bad.at(-1)).toBe("AI interview was skipped in this dry run. No profile readiness is claimed.");
  expect(large).toEqual(overLimit);
  expect(large.join("\n")).not.toMatch(/60|10|aaaa|not-shown/u);
});

test("plan paths are shown for replacements or advanced display only", () => {
  const entries = [
    { action: "new", path: "local_only/profiles/invented/profile.toml", kind: "file" },
    { action: "new", path: "local_only/profiles/invented/outbox", kind: "directory" },
    { action: "replace", path: "local_only/models.toml", kind: "file" },
    { action: "unchanged", path: "local_only/profiles/invented/screen.toml", kind: "file" },
  ] as const;

  expect(setupPlanLines(entries, false)).toEqual([
    "Planned files:", "  new  profile settings", "  new directory for profile", "  replace  local_only/models.toml",
    "  Shared AI settings affect all profiles and stages.", "  unchanged  profile data",
  ]);
  expect(setupPlanLines(entries, true)).toEqual([
    "Planned files:", "  new  local_only/profiles/invented/profile.toml", "  new directory  local_only/profiles/invented/outbox",
    "  replace  local_only/models.toml", "  Shared AI settings affect all profiles and stages.", "  unchanged  local_only/profiles/invented/screen.toml",
  ]);
  expect(setupPlanLines([], false)).toEqual(["Planned files:", "  None."]);
});
