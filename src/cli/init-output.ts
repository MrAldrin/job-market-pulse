import { Effect, Either, Predicate } from "effect";
import { basename } from "node:path";
import type { TomlTable } from "smol-toml";
import { searchModes } from "../lib/search-mode.ts";
import { modelSteps } from "../lib/server/judge/reviewers.ts";
import { checkNarrative } from "../lib/server/profile/narrative.ts";
import { pythonFloat } from "../lib/server/shared/python-json.ts";
import { parseToml } from "../lib/server/shared/toml.ts";
import type { InitPlanEntry } from "./init-plan.ts";
import { initPaths, isInitTomlTable, type InitSelectedSnapshot } from "./init-state.ts";
import { maxInterviewContextBytes } from "./interview-session.ts";

const labels = { screen: "Initial screening", judge: "Personal review", rejudge: "Repeat review", calibrate: "Calibration" } as const;
const purposeByName = new Map([["profile.toml", "profile settings"], ["models.toml", "shared AI settings"]]);

const textStates = new Map([
  ["later", "Deferred"], ["planned", "Draft planned"], ["incomplete", "Incomplete"], ["skipped", "AI interview skipped"],
]);

interface SummaryInput {
  readonly answers: TomlTable;
  readonly configText: string | undefined;
  readonly originalNarrative: InitSelectedSnapshot | null;
  readonly dryRun: boolean;
}

const keptText = (original: InitSelectedSnapshot | null): readonly string[] => {
  if (original === null) return ["Profile text: Retained; incomplete"];

  if (!("bytes" in original) || original.bytes.byteLength > maxInterviewContextBytes) return ["Profile text: Retained; NOT CHECKED (interview/summary size limit)"];

  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(original.bytes);
    const status = checkNarrative(text, { requireTemplate: false }).length === 0 ? "complete" : "incomplete";

    return [`Profile text: Retained; ${status}`];
  } catch {
    return [
      "Kept profile text could not be read as bounded UTF-8. It remains unchanged and incomplete.", "Profile text: Retained; incomplete",
    ];
  }
};

export const setupSummary = ({ answers, configText, originalNarrative, dryRun }: SummaryInput) => Effect.gen(function* () {
  const text = (key: string): string | undefined => Predicate.isString(answers[key]) ? answers[key] : undefined;
  const lines = [`Profile: ${text("profile_id") ?? "Unknown"}`];

  for (const stage of modelSteps) {
    const harness = text(`${stage}_harness`);
    const model = text(`${stage}_model`);
    const effort = text(`${stage}_effort`);

    if (harness && model) lines.push(`AI ${labels[stage]}: ${harness}, ${model}, ${effort || "unknown effort"}`);
  }

  if (text("ai_common_replaced") === "yes") lines.push("Common AI settings replace the program, model and effort for all four stages. Batch sizes stay as saved.");

  if (!modelSteps.some((stage) => text(`${stage}_model`))) lines.push("AI settings: Unknown");
  lines.push(`Area: ${text("home_label") || "Unknown"}`);

  const radius = answers.radius_km;
  const distance = Predicate.isNumber(radius) ? pythonFloat(radius) : Predicate.isBigInt(radius) ? String(radius) : undefined;
  const areas = answers.allowed_occupation_categories;
  const areaNames = Array.isArray(areas) && areas.every(Predicate.isString) ? areas.join(", ") : "";
  lines.push(`Radius: ${distance === undefined ? "Unknown" : `${distance} km`}`, `Job areas: ${areaNames || "Unknown"}`);

  const config = configText === undefined ? Either.right<TomlTable>({}) : parseToml(configText);
  const policy = (yield* config).policy;
  const mode = isInitTomlTable(policy) && (policy.mode === "passive" || policy.mode === "active") ? searchModes[policy.mode].label : undefined;
  lines.push(`Search mode: ${mode ?? "Unknown"}`, `Schedule: ${text("schedule_normalized") || text("schedule_choice") || "Unknown"}`);

  const interview = text("interview");

  if (interview === "kept") lines.push(...keptText(originalNarrative));
  else lines.push(`Profile text: ${textStates.get(interview ?? "") ?? "Unknown or incomplete"}`);

  if (dryRun) lines.push("AI interview was skipped in this dry run. No profile readiness is claimed.");

  return lines;
});

export const setupPlanLines = (entries: readonly InitPlanEntry[], advanced: boolean): readonly string[] => {
  const lines = ["Planned files:"];

  for (const { action, path, kind } of entries) {
    if (kind === "directory") lines.push(advanced ? `  ${action} directory  ${path}` : `  ${action} directory for profile`);
    else if (action === "replace" || advanced) {
      lines.push(`  ${action}  ${path}`);

      if (action === "replace" && path === initPaths.models) lines.push("  Shared AI settings affect all profiles and stages.");
    } else {
      const purpose = purposeByName.get(basename(path)) ?? "profile data";
      lines.push(`  ${action}  ${purpose}`);
    }
  }

  if (!entries.length) lines.push("  None.");

  return lines;
};
