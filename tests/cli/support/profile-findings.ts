import type { ProfileFindings } from "../../../src/cli/profile-check-output.ts";

const ok = (message: string) => ({ ok: true, message, fix: "Not printed." });

export const missingProfileFinding = (fix: string) => ({ ok: false, message: "Setup is missing or invalid.", fix });

export const completeProfileFindings: ProfileFindings = {
  profile_dir: ok("Profile directory exists."),
  profile_toml: ok("Profile policy TOML is readable."),
  narrative: ok("Profile text has enough content."),
  preferences: ok("Preferences are readable and valid."),
  origin: ok("An explicit origin is set."),
  radius: ok("An explicit radius is set."),
  occupations: ok("Allowed occupation categories are set."),
  source_db: ok("The configured source database exists."),
  reviewer: ok("Installation model settings are valid."),
  outbox: ok("The outbox directory exists."),
};

export const setupReplayFindings: ProfileFindings = {
  ...completeProfileFindings,
  source_db: { ...ok("The first refresh creates the Source database."), pending: true },
};

// Preserve the recorded oracle. This is the intentional change to its setup output.
export const withPendingSource = (stdout: string): string => stdout.replace(
  "MISSING  source_db  Setup is missing or invalid.\n  Fix: Set paths.source_db in profile.toml to an existing source database.\n",
  "PENDING  source_db  The first refresh creates the Source database.\n",
);
