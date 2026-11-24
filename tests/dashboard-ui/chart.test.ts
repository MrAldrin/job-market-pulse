import { expect, test } from 'vitest';
import {
  linearScale,
  linePath,
  niceTicks,
  pickLabels,
  pointScale,
} from '../../src/lib/chart';

// Inputs from tests/test_svg_charts.py; expected values from the Python helper.
test.each<[number, number, number[]]>([
  [0, 7, [0, 2, 4, 6, 8]],
  [0, 1000, [0, 250, 500, 750, 1000]],
  [0, 0.3, [0, 0.1, 0.2, 0.3]],
  [0, 12345, [0, 5000, 10000, 15000]],
  [5, 5.5, [5, 5.2, 5.4, 5.6]],
  [0, 0, [0, 0.25, 0.5, 0.75, 1]],
  [-7, 7, [-10, -5, 0, 5, 10]],
  [5, 2, [5, 5.25, 5.5, 5.75, 6]],
])(
  'niceTicks(%s, %s) matches Python',
  (low, high, expected) => {
    expect(niceTicks(low, high)).toEqual(expected);
  },
);

test('invalid tick bounds give no ticks', () => {
  expect(niceTicks(NaN, 1)).toEqual([]);
  expect(niceTicks(0, Infinity)).toEqual([]);
});

test('linear scale maps, inverts, and extrapolates', () => {
  const scale = linearScale([0, 10], [100, 0]);
  expect([scale(0), scale(5), scale(10), scale(20)]).toEqual([
    100, 50, 0, -100,
  ]);
  expect(linearScale([10, 0], [0, 100])(5)).toBe(50);
  expect(linearScale([2, 2], [10, 30])(2)).toBe(20);
});

test('point scale includes endpoints and centers a singleton or empty set', () => {
  const scale = pointScale(3, [10, 30]);
  expect([scale(0), scale(1), scale(2)]).toEqual([10, 20, 30]);
  expect(pointScale(1, [10, 30])(0)).toBe(20);
  expect(pointScale(0, [10, 30])(0)).toBe(20);
  expect(() => pointScale(-1, [0, 1])).toThrow(RangeError);
});

test('paths restart after gaps and retain actual zero values', () => {
  expect(
    linePath([null, [0, 0], [1, 2], null, null, [3, 4], [4, 5], null]),
  ).toBe('M0,0 L1,2 M3,4 L4,5');
  expect(
    linePath([
      [0, 1],
      [1, NaN],
      [2, 0],
      [Infinity, 3],
    ]),
  ).toBe('M0,1 M2,0');
  expect(linePath([null, null])).toBe('');
  expect(linePath([])).toBe('');
});

test('labels follow Python thinning, with bounded counts and valid indexes', () => {
  const labels = Array.from({ length: 22 }, (_, i) => String(i));
  expect(pickLabels(labels, 5)).toEqual([0, 5, 10, 15, 20]);
  expect(pickLabels(['a', 'b'], 10)).toEqual([0, 1]);
  expect(pickLabels(labels, 1)).toEqual([0]);
  expect(pickLabels(labels, 0)).toEqual([]);
  expect(pickLabels([], 5)).toEqual([]);
});
