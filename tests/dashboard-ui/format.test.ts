import { describe, expect, test, vi } from 'vitest';
import {
  count,
  fitLabel,
  isNew,
  money,
  percent,
  relativeTime,
  shortDate,
} from '../../src/lib/format';

const NOW = new Date('2026-05-01T12:00:00Z');

describe('relativeTime', () => {
  test.each([
    ['2026-05-01T00:00:00Z', 'today'],
    ['2026-04-30T23:59:59Z', 'yesterday'],
    ['2026-04-28T12:00:00Z', '3 days ago'],
    ['2026-04-25T12:00:00Z', '6 days ago'],
    ['2026-04-24T12:00:00Z', '1 week ago'],
    ['2026-04-17T12:00:00Z', '2 weeks ago'],
    ['2026-04-02T12:00:00Z', '4 weeks ago'],
    ['2026-04-01T12:00:00Z', '1 month ago'],
    ['2026-01-01T12:00:00Z', '4 months ago'],
    [null, 'unknown'],
    ['', 'unknown'],
    ['not-a-date', 'unknown'],
    ['2026-02-30T12:00:00Z', 'unknown'],
    ['2026-04-01T12:00:00', 'unknown'],
    ['2026-05-01T12:00:01Z', 'unknown'],
    ['2026-05-02T12:00:00Z', 'unknown'],
  ])('%s → %s', (iso, expected) => {
    expect(relativeTime(iso, NOW)).toBe(expected);
  });

  test('uses UTC midnight and explicit offsets', () => {
    const midnight = new Date('2026-05-01T00:00:00Z');
    expect(relativeTime('2026-04-30T23:59:59.999Z', midnight)).toBe(
      'yesterday',
    );
    expect(relativeTime('2026-05-01T01:59:59+02:00', midnight)).toBe(
      'yesterday',
    );
    expect(relativeTime('2026-05-01T02:00:00+02:00', midnight)).toBe('today');
  });

  test('rejects an invalid now', () => {
    expect(relativeTime('2026-01-01', new Date('invalid'))).toBe('unknown');
  });
});

describe('shortDate', () => {
  test.each([
    ['2026-01-09T08:00:00+00:00', '9 Jan 2026'],
    ['2026-01-09', '9 Jan 2026'],
    ['2026-01-01T00:30:00+02:00', '31 Dec 2025'],
    ['2024-02-29T12:00:00Z', '29 Feb 2024'],
    ['2000-02-29', '29 Feb 2000'],
    [null, '–'],
    ['invalid', '–'],
    ['2026-02-29', '–'],
    ['1900-02-29', '–'],
    ['2026-04-31', '–'],
    ['2026-13-01', '–'],
    ['2026-01-00', '–'],
    ['2026-01-09T08:00:00', '–'],
    ['2026-01-09T25:00:00Z', '–'],
  ])('%s → %s', (iso, expected) => {
    expect(shortDate(iso)).toBe(expected);
  });
});

describe('isNew', () => {
  test.each([
    ['2026-05-01T12:00:00Z', true],
    ['2026-04-25T00:00:00Z', true],
    ['2026-04-24T23:59:59Z', false],
    ['2026-05-01T12:00:01Z', false],
    [null, false],
    ['invalid', false],
    ['2026-02-30', false],
  ])(
    '%s → %s with the default seven-day window',
    (first_found_at, expected) => {
      expect(isNew({ first_found_at }, NOW)).toBe(expected);
    },
  );

  test('uses UTC day boundaries for a custom window', () => {
    const midnight = new Date('2026-05-01T00:00:00Z');
    const job = { first_found_at: '2026-04-30T23:59:59.999Z' };
    expect(isNew(job, midnight, 1)).toBe(false);
    expect(isNew(job, midnight, 2)).toBe(true);
    expect(isNew({ first_found_at: '2026-05-01' }, midnight, 1)).toBe(true);
  });

  test.each([0, -1, 1.5, NaN, Infinity])(
    'rejects an invalid window %s',
    (days) => {
      expect(isNew({ first_found_at: '2026-05-01' }, NOW, days)).toBe(false);
    },
  );

  test('rejects an invalid now', () => {
    expect(isNew({ first_found_at: '2026-01-01' }, new Date('invalid'))).toBe(
      false,
    );
  });

  test('does not read the current clock or mutate its inputs', () => {
    const job = Object.freeze({ first_found_at: '2026-05-01T00:00:00Z' });
    const before = NOW.getTime();

    const clock = vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('Do not read the current clock');
    });

    try {
      expect(relativeTime(job.first_found_at, NOW)).toBe('today');
      expect(shortDate(job.first_found_at)).toBe('1 May 2026');
      expect(isNew(job, NOW)).toBe(true);
      expect(NOW.getTime()).toBe(before);
      expect(clock).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });
});

describe('fitLabel', () => {
  test.each([
    ['exceptional', 'Exceptional'],
    ['strong', 'Strong'],
    ['possible', 'Possible'],
    ['poor', 'Poor'],
    ['unknown', 'Not judged'],
  ] as const)('%s → %s', (fit, expected) => {
    expect(fitLabel(fit)).toBe(expected);
  });

  test('has a safe fallback for invalid runtime values', () => {
    // @ts-expect-error Exercise invalid input from an untyped caller.
    expect(fitLabel('unsupported')).toBe('Not judged');
    // @ts-expect-error Do not expose inherited object properties as labels.
    expect(fitLabel('toString')).toBe('Not judged');
    // @ts-expect-error Exercise null input from an untyped caller.
    expect(fitLabel(null)).toBe('Not judged');
  });
});

describe('count', () => {
  test.each([
    [0, '0 jobs'],
    [1, '1 job'],
    [3, '3 jobs'],
    [-1, '–'],
    [1.5, '–'],
    [NaN, '–'],
    [Infinity, '–'],
  ])('%s → %s', (n, expected) => {
    expect(count(n, 'job', 'jobs')).toBe(expected);
  });
});

describe('money', () => {
  test.each([
    [650_000, '650 000 kr'],
    [1_234_567, '1 234 567 kr'],
    [0, '0 kr'],
    [650_000.5, '650 001 kr'],
    [-1_234, '-1 234 kr'],
    [NaN, '–'],
    [Infinity, '–'],
    [-Infinity, '–'],
  ])('%s → %s', (n, expected) => {
    expect(money(n)).toBe(expected);
  });
});

describe('percent', () => {
  test.each([
    [124, 1000, '12.4%'],
    [1, 3, '33.3%'],
    [0, 10, '0.0%'],
    [10, 10, '100.0%'],
    [0, 0, '–'],
    [1, 0, '–'],
    [1, -1, '–'],
    [-1, 10, '–'],
    [NaN, 10, '–'],
    [1, NaN, '–'],
    [Infinity, 10, '–'],
    [1, Infinity, '–'],
    [Number.MAX_VALUE, Number.MIN_VALUE, '–'],
  ])('%s / %s → %s', (part, total, expected) => {
    expect(percent(part, total)).toBe(expected);
  });
});
