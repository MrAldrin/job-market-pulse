import type { Preferences } from "../../contracts/profile-settings.ts";
import { normalized, caseFold } from "../shared/text.ts";
import { codepointOrder } from "../shared/python-json.ts";

export type OccupationPair = readonly [string, string];

// A preferred title term is evidence only. It cannot rescue missing occupations.
export const occupationAllowed = (pairs: readonly OccupationPair[], allowed: readonly string[]): boolean => {
  const rules = allowed.map((item): readonly [string, string | undefined] => {
    const label = normalized(item);
    const separator = label.indexOf(" / ");

    return separator < 0 ? [label, undefined] : [label.slice(0, separator), label.slice(separator + 3)];
  });

  return pairs.some(([level1, level2]) => rules.some(([left, right]) => normalized(level1) === left && (right === undefined || normalized(level2) === right)));
};

export const admissionAllowed = (_title: string, pairs: readonly OccupationPair[], preferences: Preferences): boolean => occupationAllowed(pairs, preferences.allowed_occupation_categories);

export const occupationLabels = (pairs: readonly OccupationPair[]): readonly string[] => Array.from(new Set(pairs.map(([left, right]) => right ? `${left} / ${right}` : left))).sort((left, right) => {
  const a = caseFold(left);
  const b = caseFold(right);

  return codepointOrder(a, b);
});

// The caller owns timestamp validation. This rule only removes input rows and
// preserves their order and identities; null expiry remains eligible here.
export const filterEligible = <Job extends { readonly title: string; readonly excludedReason: string | null; readonly expiresAt: bigint | null; readonly occupationPairs: readonly OccupationPair[] }>(jobs: readonly Job[], preferences: Preferences, now: bigint): readonly Job[] => jobs.filter((job) => job.excludedReason === null && (job.expiresAt === null || job.expiresAt > now) && admissionAllowed(job.title, job.occupationPairs, preferences));
