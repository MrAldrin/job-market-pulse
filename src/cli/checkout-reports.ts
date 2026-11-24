import { Effect } from "effect";
import { ProfileFiles } from "../lib/server/profile/files.ts";
import { installationSetting } from "../lib/server/shared/installation-paths.ts";
import { readSelectedProfile } from "./pulse-selection.ts";
import { pulseStatus } from "./pulse-status.ts";
import { collectProfileFindings } from "./profile-check.ts";

export interface CheckoutReport {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitStatus: number;
}

export interface CheckoutHost {
  readonly defaultRoot: string;
  readonly which: (name: string, searchPath?: string) => string | null;
}

export interface CheckoutSelection {
  readonly root: string;
  readonly explicit: string | undefined;
}

const setupHint = (path: string): CheckoutReport => ({
  stdout: "", stderr: `Profile not selected. Set profile = "<profile-id>" in ${path}, or pass --profile <profile-id>.\n`, exitStatus: 2,
});

export const withSelected = <E, R>(selection: CheckoutSelection, use: (root: string, id: string) => Effect.Effect<CheckoutReport, E, R>) => Effect.gen(function* () {
  if (selection.explicit !== undefined) return yield* use(selection.root, selection.explicit);
  const files = yield* ProfileFiles;
  const root = yield* files.root(selection.root).pipe(Effect.orElseSucceed(() => null));

  if (root === null) return setupHint("local_only/pulse.toml");
  const id = yield* readSelectedProfile(root, undefined).pipe(Effect.orElseSucceed(() => null));

  if (id === null) return setupHint(installationSetting(root, "local_only/pulse.toml"));

  return yield* use(root, id);
});

export const checkoutStatus = (selection: CheckoutSelection) => withSelected(selection, (root, id) => Effect.gen(function* () {
  const status = yield* pulseStatus(root, id);

  if (status.exitStatus !== 0) return status;
  const findings = yield* collectProfileFindings(root, id);
  const missing = Object.entries(findings).filter(([, finding]) => !finding.ok && !finding.pending).map(([name]) => name);

  const warning = missing.length === 0 ? "" : `Setup checks missing or invalid: ${missing.join(", ")}. Run pulse init to review setup.\n`;
  const source = findings.source_db;
  const pending = source.pending ? source.message + "\n" + (source.ok ? "" : `Fix: ${source.fix}\n`) : "";

  return { ...status, stderr: warning + pending };
}));
