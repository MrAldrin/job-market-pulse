export const isMonthLabel = (label: string): boolean => label.length === 7 && /^(?!0000)\d{4}-(?:0[1-9]|1[0-2])$/.test(label);

export const consecutiveMonths = (previous: string, current: string): boolean => {
  if (!isMonthLabel(previous) || !isMonthLabel(current)) return false;

  const ordinal = (month: string) => Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7));

  return ordinal(current) - ordinal(previous) === 1;
};

const dayMillis = 86_400_000;

const firstIsoMonday = (year: number): number => {
  const jan4 = new Date(0);
  jan4.setUTCFullYear(year, 0, 4);

  return jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * dayMillis;
};

export const isoWeekStart = (label: string): number | null => {
  if (label.length !== 13 || !/^week-(?!0000)\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/.test(label)) return null;

  const year = Number(label.slice(5, 9));
  const week = Number(label.slice(11));
  const monday = firstIsoMonday(year) + (week - 1) * 7 * dayMillis;

  return monday < firstIsoMonday(year + 1) ? monday : null;
};

export const consecutiveIsoWeeks = (previous: string, current: string): boolean => {
  const a = isoWeekStart(previous), b = isoWeekStart(current);

  return a !== null && b !== null && b - a === 7 * dayMillis;
};

export const daysBetween = (previous: string, current: string): number =>
  (Date.parse(`${current}T00:00:00Z`) - Date.parse(`${previous}T00:00:00Z`)) / dayMillis;
