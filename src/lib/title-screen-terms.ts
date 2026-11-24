const phrase = String.raw`[\p{L}\p{N}][\p{L}\p{M}\p{N}]*(?:[ -][\p{L}\p{N}][\p{L}\p{M}\p{N}]*)*`;
export const titleScreenTerm = new RegExp(`^${phrase}\\*?(?![\\s\\S])`, "u");
const wordCharacters = String.raw`[\p{L}\p{M}\p{N}_]`;
const start = `(?<!${wordCharacters})`;
const end = `(?!${wordCharacters})`;
const spaces = String.raw`\s+`;

export function screenTermPattern(term: string): string {
  const prefix = term.endsWith("*");
  const words = (prefix ? term.slice(0, -1) : term).replaceAll(" ", spaces);

  return start + words + (prefix ? wordCharacters + "*" : end);
}

export function readScreenTerm(pattern: string): string | undefined {
  const legacy = pattern.startsWith(String.raw`\b`);
  const before = legacy ? String.raw`\b` : start;
  const exact = legacy ? String.raw`\b` : end;
  const wildcard = legacy ? String.raw`\w*` : wordCharacters + "*";

  if (!pattern.startsWith(before)) return undefined;
  const suffix = pattern.endsWith(wildcard) ? wildcard : pattern.endsWith(exact) ? exact : null;

  if (suffix === null) return undefined;
  const body = pattern.slice(before.length, -suffix.length).replaceAll(spaces, " ");

  if (body.endsWith("*") || !titleScreenTerm.test(body)) return undefined;

  return body + (suffix === wildcard ? "*" : "");
}

export function screenListView(patterns: readonly string[]) {
  const terms = new Set<string>();
  const advanced: string[] = [];

  for (const pattern of patterns) {
    const term = readScreenTerm(pattern);

    if (term === undefined) advanced.push(pattern);
    else terms.add(term);
  }

  return { terms: [...terms], advanced };
}
