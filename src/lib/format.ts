import type { Fit } from './snapshot';

const DAY_MS = 86_400_000;
const UNKNOWN = '–';

const FIT_LABELS = {
  exceptional: 'Exceptional',
  strong: 'Strong',
  possible: 'Possible',
  poor: 'Poor',
  unknown: 'Not judged',
} as const;

const dateFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

const osloDateTime = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric', month: 'short', year: 'numeric',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Europe/Oslo',
});

export function osloMinute(iso: string | null): string | null {
  if (!iso?.includes('T')) return null;
  const value = timestamp(iso);

  return Number.isFinite(value) ? osloDateTime.format(value) : null;
}

export function elapsedAge(iso: string, now: Date): string {
  const minutes = Math.floor((now.getTime() - timestamp(iso)) / 60_000);

  if (!Number.isFinite(minutes) || minutes < 0) return 'age unknown';

  if (minutes === 0) return 'less than a minute ago';

  if (minutes < 60) return ageLabel(minutes, 'minute');

  if (minutes < 1440) return ageLabel(Math.floor(minutes / 60), 'hour');

  return ageLabel(Math.floor(minutes / 1440), 'day');
}

function ageLabel(value: number, unit: string): string {
  return `${value} ${unit}${value === 1 ? '' : 's'} ago`;
}

const moneyFormat = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 0,
});

// Accept ISO dates or timestamps with an explicit offset. Do not let Date.parse
// infer a local timezone or normalize an impossible calendar date.
function timestamp(iso: string | null): number {
  if (iso === null) return NaN;

  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/.exec(
      iso,
    );

  if (!match) return NaN;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

  const monthDays = [
    31,
    leap ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];

  if (month < 1 || month > 12 || day < 1 || day > (monthDays[month - 1] ?? 0)) {
    return NaN;
  }

  return Date.parse(iso);
}

function ageInDays(iso: string | null, now: Date): number {
  const found = timestamp(iso);
  const current = now.getTime();

  if (!Number.isFinite(found) || !Number.isFinite(current) || found > current) {
    return NaN;
  }

  return Math.floor(current / DAY_MS) - Math.floor(found / DAY_MS);
}

/** Use UTC calendar days; weeks have 7 days and display months have 30 days. */
export function relativeTime(iso: string | null, now: Date): string {
  const days = ageInDays(iso, now);

  if (!Number.isFinite(days)) return 'unknown';

  if (days === 0) return 'today';

  if (days === 1) return 'yesterday';

  if (days < 7) return `${days} days ago`;

  if (days < 30) {
    const weeks = Math.floor(days / 7);

    return `${weeks} ${weeks === 1 ? 'week' : 'weeks'} ago`;
  }

  const months = Math.floor(days / 30);

  return `${months} ${months === 1 ? 'month' : 'months'} ago`;
}

export function shortDate(iso: string | null): string {
  const value = timestamp(iso);

  return Number.isFinite(value) ? dateFormat.format(value) : UNKNOWN;
}

/** Only first_found_at is needed; a future snapshot Job is structurally valid. */
export function isNew(
  job: { first_found_at: string | null },
  now: Date,
  days = 7,
): boolean {
  if (!Number.isInteger(days) || days <= 0) return false;
  const age = ageInDays(job.first_found_at, now);

  return Number.isFinite(age) && age < days;
}

export function fitLabel(fit: Fit): string {
  return Object.hasOwn(FIT_LABELS, fit) ? FIT_LABELS[fit] : FIT_LABELS.unknown;
}

export function count(n: number, one: string, many: string): string {
  if (!Number.isSafeInteger(n) || n < 0) return UNKNOWN;

  return `${n} ${n === 1 ? one : many}`;
}

/** Round to whole kroner and use ordinary spaces for grouping. */
export function money(n: number): string {
  if (!Number.isFinite(n)) return UNKNOWN;

  return `${moneyFormat.format(n).replaceAll(',', ' ')} kr`;
}

export function percent(part: number, total: number): string {
  if (
    !Number.isFinite(part) ||
    !Number.isFinite(total) ||
    part < 0 ||
    total <= 0
  ) {
    return UNKNOWN;
  }

  const value = (part / total) * 100;

  return Number.isFinite(value) ? `${value.toFixed(1)}%` : UNKNOWN;
}
