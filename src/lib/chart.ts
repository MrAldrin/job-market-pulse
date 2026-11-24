/** Pure geometry helpers. No data loading or chart-library dependency. */
export function niceTicks(low: number, high: number): number[] {
  if (!Number.isFinite(low) || !Number.isFinite(high)) return [];

  if (!(high > low)) high = low + 1;
  const magnitude = Math.floor(Math.log10(high - low));

  for (const exponent of [magnitude - 1, magnitude, magnitude + 1]) {
    for (const multiple of [1, 2, 2.5, 5]) {
      const step = multiple * 10 ** exponent;
      const first = Math.floor(low / step);
      const last = Math.ceil(high / step);

      if (last - first <= 4) {
        return Array.from({ length: last - first + 1 }, (_, i) => {
          const value = Number(((first + i) * step).toFixed(10));

          return value === 0 ? 0 : value;
        });
      }
    }
  }

  return [low, high];
}

/** A collapsed domain maps to the range midpoint; values are not clamped. */
export function linearScale(
  domain: [number, number],
  range: [number, number],
): (v: number) => number {
  const [low, high] = domain;
  const [start, end] = range;

  if (low === high) return () => (start + end) / 2;

  return (value) => start + ((value - low) / (high - low)) * (end - start);
}

/** Points include both endpoints; one point is centered. */
export function pointScale(
  count: number,
  range: [number, number],
): (i: number) => number {
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError('Point count must be a non-negative integer');
  }

  return linearScale([0, Math.max(0, count - 1)], range);
}

/** Null and non-finite coordinates break a path, rather than implying zero. */
export function linePath(points: ([number, number] | null)[]): string {
  const parts: string[] = [];
  let connected = false;

  for (const point of points) {
    if (point === null || !point.every(Number.isFinite)) {
      connected = false;
      continue;
    }

    parts.push(`${connected ? 'L' : 'M'}${point[0]},${point[1]}`);
    connected = true;
  }

  return parts.join(' ');
}

/** Match the Python x-axis thinning rule: show every ceil(n/capacity) label. */
export function pickLabels(labels: string[], maxCount: number): number[] {
  if (!labels.length || !Number.isFinite(maxCount) || maxCount < 1) return [];
  const step = Math.ceil(labels.length / Math.floor(maxCount));

  return Array.from(
    { length: Math.ceil(labels.length / step) },
    (_, i) => i * step,
  );
}
