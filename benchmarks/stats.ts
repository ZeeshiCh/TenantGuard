export interface Samples {
  readonly count: number;
  readonly meanMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly operationsPerSecond: number;
}
export function summarize(samples: readonly number[]): Samples {
  if (!samples.length || samples.some((n) => !Number.isFinite(n) || n < 0))
    throw new TypeError('Expected finite nonnegative duration samples');
  const sorted = [...samples].sort((a, b) => a - b),
    mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  return {
    count: samples.length,
    meanMs: mean,
    p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1]!,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
    minMs: sorted[0]!,
    maxMs: sorted.at(-1)!,
    operationsPerSecond: mean > 0 ? 1000 / mean : 0,
  };
}
export function count(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (
    !/^[0-9]+$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < 1 ||
    Number(value) > 10000
  )
    throw new TypeError(
      'Iterations and warmup must be integers from 1 to 10000',
    );
  return Number(value);
}
export async function measure(
  name: string,
  work: () => unknown | Promise<unknown>,
  iterations: number,
  warmup: number,
) {
  for (let i = 0; i < warmup; i++) await work();
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await work();
    samples.push(performance.now() - start);
  }
  return {
    name,
    unit: 'milliseconds per complete operation',
    ...summarize(samples),
  };
}
