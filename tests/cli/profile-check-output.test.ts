import { expect, test } from "vitest";
import { profileCheckOutput, setupReadinessLines } from "../../src/cli/profile-check-output.ts";
import configured from "../oracle/basic-run/cli/operations/profile-check-configured.json";
import unconfigured from "../oracle/basic-run/cli/operations/profile-check.json";
import setup from "../oracle/setup-interview/cli/init.json";
import { completeProfileFindings, missingProfileFinding, setupReplayFindings, withPendingSource } from "./support/profile-findings.ts";

test("matches the recorded standalone profile check with and without model settings", () => {
  const reviewer = missingProfileFinding("Create or correct local_only/models.toml using config/models.example.toml.");
  expect(profileCheckOutput(completeProfileFindings)).toEqual({ stdout: configured.stdout, exitStatus: configured.exit_status });
  expect(profileCheckOutput({ ...completeProfileFindings, reviewer })).toEqual({ stdout: unconfigured.stdout, exitStatus: unconfigured.exit_status });
});

test("formats the frozen setup readiness suffix from supplied findings", () => {
  const lines = setupReadinessLines(setupReplayFindings);
  const start = setup.stdout.indexOf("ok  profile_dir");

  expect(lines.join("\n") + "\n").toBe(withPendingSource(setup.stdout.slice(start)));
});

test.each([
  ["reviewer", "pulse init --step reviewer"],
  ["narrative", "pulse init --step interview"],
  ["outbox", "Correct the remaining MISSING checks above before refresh."],
  ["source_db", "Correct the remaining MISSING checks above before refresh."],
] as const)("does not suggest a refresh while %s needs repair", (code, nextStep) => {
  const lines = setupReadinessLines({ ...setupReplayFindings, [code]: missingProfileFinding("Correct this check.") });
  expect(lines.at(-1)).toContain(nextStep);
  expect(lines.join("\n")).not.toContain("pulse refresh");
});
