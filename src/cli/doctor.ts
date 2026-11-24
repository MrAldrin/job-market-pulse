import { Effect } from "effect";
import { dirname, join } from "node:path";
import type { DoctorCheck, DoctorReport } from "../lib/contracts/doctor.ts";
import { checkoutBuildFix, checkoutBuildMessages } from "../lib/server/dashboard/checkout-build.ts";
import { harnessExecutables } from "../lib/server/judge/reviewer-detect.ts";
import { modelSteps } from "../lib/server/judge/reviewers.ts";
import { decodeProfileId } from "../lib/server/profile/core.ts";
import { ProfileFiles } from "../lib/server/profile/files.ts";
import { minimumNode, nodeFix, pinnedBun, supportsNode } from "./checkout-toolchain.ts";
import type { CheckoutSelection } from "./checkout-reports.ts";
import type { DesktopLauncher } from "./desktop-launcher.ts";
import { databasePathState, type DoctorHost } from "./doctor-host.ts";
import { initPaths } from "./init-state.ts";
import { profileCheckCodes } from "./profile-check-output.ts";
import { collectProfileEvidence, readProfileModels } from "./profile-check.ts";
import { readSelectedProfile } from "./pulse-selection.ts";

const selectionFix = 'Run pulse init, set profile in local_only/pulse.toml, or pass --profile ID before doctor.';

const finding = (id: string, ok: boolean, pass: string, fail: string, fix: string, required = true): DoctorCheck => ({
  id, required, ok, message: ok ? pass : fail, fix: ok ? null : fix,
});

const dataFinding = (id: string, ok: boolean): DoctorCheck => finding(id, ok,
  "Can create files in this directory or its nearest existing parent.", "Cannot create files safely for this data directory.",
  "Check the directory and its parents for access, links or a name conflict. Keep data inside the installation.");

const harnessCheck = (host: DoctorHost): DoctorCheck => {
  switch (host.platform) {
    case "linux": return finding("ai_harness", host.which("pi") !== null || host.which("claude") !== null,
      "Pi or Claude Code is on PATH. Sign-in was not checked.", "Neither Pi nor Claude Code is on PATH.", "Install Pi or Claude Code and add it to PATH.");
    case "darwin": return finding("ai_harness", host.which("claude") !== null,
      "Claude Code is on PATH. Sign-in was not checked.", "Claude Code is not on PATH. Pulse does not support Pi review on macOS.", "Install Claude Code and add it to PATH.");
    case "win32": return finding("ai_harness", host.which("claude.exe") !== null,
      "Native Claude Code (claude.exe) is on PATH. Sign-in was not checked.", "Native Claude Code (claude.exe) is not on PATH.", "Install native Claude Code (claude.exe) and add it to PATH. Pi and .cmd wrappers are not supported.");
    default: return finding("ai_harness", false, "", "Pulse has no supported harness on this platform.", "Run Pulse on Linux, macOS or Windows.");
  }
};

const schedulerCheck = (host: DoctorHost) => Effect.gen(function* () {
  const probe = (name: string, args: readonly string[]) => {
    const executable = host.which(name);

    return executable === null ? Effect.succeed(false) : host.commandOk(executable, args);
  };

  switch (host.platform) {
    case "linux": return finding("scheduler", yield* probe("systemctl", ["--user", "show", "--property=Version"]),
      "User systemd is reachable.", "Cannot reach user systemd.", "Use a systemd user session with systemctl on PATH, or run Pulse manually.");
    case "darwin": return finding("scheduler", host.uid !== undefined && (yield* probe("launchctl", ["print", `gui/${host.uid}`])),
      "The launchd login domain is reachable.", "Cannot reach the launchd login domain.", "Run from a macOS graphical login with launchctl on PATH, or run Pulse manually.");
    case "win32": return finding("scheduler", yield* probe("schtasks.exe", ["/Query"]),
      "Windows Task Scheduler is reachable.", "Cannot query Windows Task Scheduler.", "Check that schtasks.exe is on PATH and Task Scheduler is available to your user, or run Pulse manually.");
    default: return finding("scheduler", false, "", "Pulse has no scheduler check for this platform.", "Run Pulse manually.");
  }
});

const profileChecks = (root: string, explicit: string | undefined, host: DoctorHost) => Effect.gen(function* () {
  const files = yield* ProfileFiles;
  const data = join(root, "data");
  const writable = new Map([[data, yield* host.canWrite(root, data)]]);
  const checks = [dataFinding("data_installation", writable.get(data) === true)];

  const id = yield* readSelectedProfile(root, explicit).pipe(
    Effect.flatMap(decodeProfileId), Effect.orElseSucceed(() => null),
  );

  checks.push(finding("profile_selected", id !== null, "A profile ID is selected.", "No valid profile ID is selected.", selectionFix));

  if (id === null) return checks;

  const directory = join(root, initPaths.profiles, id);
  const exists = yield* files.check(root, directory, "Directory").pipe(Effect.orElseSucceed(() => false));
  const { findings, paths } = yield* collectProfileEvidence(root, id, exists);

  for (const code of profileCheckCodes) {
    // The first refresh can create the Source database. Doctor does not need it.
    if (code === "source_db") continue;
    const { ok, message, fix } = findings[code];

    checks.push({ id: code, required: true, ok, message, fix: ok ? null : fix });
  }

  if (paths !== null) {
    const targets = [
      ["data_profile", paths.directory], ["data_source", dirname(paths.source_db), paths.source_db],
      ["data_review", dirname(paths.review_db), paths.review_db], ["data_ledger", dirname(paths.ledger_db), paths.ledger_db],
      ["data_outbox", paths.outbox_dir],
    ] as const;

    for (const [code, target, database] of targets) {
      if (database !== undefined && (yield* databasePathState(root, database)) === "invalid") {
        checks.push(finding(code, false, "", "The configured database path is not a safe file path.",
          "Check the database path in profile.toml. Use a regular file or a path that does not exist yet, inside the installation."));
        continue;
      }

      const ok = writable.get(target) ?? (yield* host.canWrite(root, target));
      writable.set(target, ok);
      checks.push(dataFinding(code, ok));
    }
  }

  return checks;
});

export const checkoutDoctor = (selection: CheckoutSelection, host: DoctorHost, json: boolean, launcher?: DesktopLauncher) => Effect.gen(function* () {
  const files = yield* ProfileFiles;
  const root = yield* files.root(selection.root).pipe(Effect.orElseSucceed(() => null));

  const desktop = host.platform === "linux" ? launcher : undefined;
  const installed = desktop !== undefined && (yield* desktop.installed);
  const models = installed && root !== null ? yield* readProfileModels(root) : null;
  const names = models === null ? [] : [...new Set(modelSteps.map((step) => harnessExecutables[models[step].harness]))];
  const problem = names.length === 0 ? null : yield* desktop?.harnessProblem?.(names) ?? Effect.succeed(null);

  const build = yield* host.dashboardBuild;
  const node = host.checkoutNode === null ? null : yield* host.checkoutNode;

  const checks: DoctorReport["checks"] = [
    finding("bun", host.bunVersion === pinnedBun, `Running Bun ${pinnedBun}.`, `Expected Bun ${pinnedBun}.`, `Use Bun ${pinnedBun} from package.json. For an installed executable, use a build with that Bun version.`),
    ...(host.checkoutNode === null ? [] : [finding("node", supportsNode(node), `Node.js ${node} is on PATH.`,
      node === null ? "Node.js is missing or could not report its version." : `Node.js ${node} does not meet the requirement (stable ${minimumNode} or newer).`, nodeFix)]),
    finding("git", host.which("git") !== null, "Git is on PATH.", "Git is not on PATH.", "Install Git and add it to PATH."),
    harnessCheck(host),
    finding("installation_root", root !== null, "Installation root is valid.", "Cannot resolve a safe installation root.", "Select the checkout or installation data directory with --root PATH before doctor."),
    ...(root === null ? [] : yield* profileChecks(root, selection.explicit, host)),
    yield* schedulerCheck(host),
    ...(build === null ? [] : [finding("dashboard_build", build === "current",
      checkoutBuildMessages.current, checkoutBuildMessages[build], checkoutBuildFix(build), false)]),
    ...(desktop === undefined ? [] : [finding("desktop_launcher", installed && problem === null,
      "Desktop launcher installed.", problem ?? "Desktop launcher not installed or outdated.", "Run pulse desktop install-launcher from a shell where the configured harnesses work.", false)]),
    finding("ntfy_topic", root !== null && (yield* host.hasNtfyTopic(root)), "An ntfy topic is set.",
      root === null ? "The ntfy topic was not checked because the installation root is invalid." : "No ntfy topic is configured.",
      "Leave unset if you do not need notifications.", false),
  ];

  const report: DoctorReport = { schema: "pulse.doctor", schema_version: 1, platform: host.platform, checks };

  const lines = checks.map(({ id, ok, message, required, fix }) =>
    `${ok ? "ok" : required ? "MISSING" : "OPTIONAL"}  ${id}  ${message}${fix === null ? "" : ` Fix: ${fix}`}`);

  return {
    stdout: (json ? JSON.stringify(report) : lines.join("\n")) + "\n", stderr: "",
    exitStatus: checks.some(({ required, ok }) => required && !ok) ? 1 : 0,
  };
});
