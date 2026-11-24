export const profileCheckCodes = ["profile_dir", "profile_toml", "narrative", "preferences", "origin", "radius", "occupations", "source_db", "reviewer", "outbox"] as const;

export type ProfileCheckCode = typeof profileCheckCodes[number];

interface ProfileFinding {
  readonly ok: boolean;
  readonly pending?: true;
  readonly message: string;
  readonly fix: string;
}

export type ProfileFindings = Readonly<Record<ProfileCheckCode, ProfileFinding>>;

const findingLine = (code: ProfileCheckCode, finding: ProfileFinding): string => `${finding.pending ? "PENDING" : finding.ok ? "ok" : "MISSING"}  ${code}  ${finding.message}`;

export const profileCheckOutput = (findings: ProfileFindings) => ({
  stdout: profileCheckCodes.map((code) => {
    const finding = findings[code];

    return `${findingLine(code, finding)}${finding.ok ? "" : `  Fix: ${finding.fix}`}\n`;
  }).join(""),
  exitStatus: profileCheckCodes.every((code) => findings[code].ok) ? 0 : 1,
});

export const setupReadinessLines = (findings: ProfileFindings): readonly string[] => {
  const lines = profileCheckCodes.flatMap((code) => {
    const finding = findings[code];
    const line = findingLine(code, finding);

    return finding.ok ? [line] : [line, `  Fix: ${finding.fix}`];
  });

  const missing = new Set(profileCheckCodes.filter((code) => !findings[code].ok));
  lines.push("What to do next");

  if (missing.has("reviewer")) lines.push("Set up reviewer access before refresh. Install Pi or Claude Code, then run: pulse init --step reviewer");

  if (missing.has("narrative")) lines.push("Write your profile: pulse init --step interview");

  if ([...missing].some((code) => code !== "reviewer" && code !== "narrative" && !findings[code].pending)) {
    lines.push("Correct the remaining MISSING checks above before refresh.");
  }

  if (missing.size) return lines;

  if (findings.source_db.pending) lines.push(
    "Get the first jobs: pulse refresh --no-publish",
    "This contacts NAV's public job feed. See docs/pipeline/nav-feed.md for the terms.",
  );
  else lines.push("Run: pulse refresh --no-publish, then: pulse dashboard");

  return lines;
};
