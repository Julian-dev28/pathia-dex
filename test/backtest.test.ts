/**
 * Tests for the backtest statistics and the dataset reader.
 *
 * The replay path itself needs a chain, so it is exercised by running
 * `npm run backtest`. What is tested here is everything that turns raw
 * observations into a published claim — because a summary function that
 * quietly drops losses, or a percentile that is off by one at the ends, would
 * make the site state something untrue while every other test stayed green.
 */

import { describe, it, expect } from 'vitest';
import { summarise, median, percentile, type BacktestResult } from '@/lib/backtest';

const sample = (edgeBps: number, extra: Partial<BacktestResult> = {}): BacktestResult => ({
  txHash: '0xabc',
  blockNumber: '1',
  pair: 'WETH/USDC',
  amountIn: '1',
  actualOut: '1',
  routerOut: '1',
  edgeBps,
  routerVenue: 'Uniswap V3 0.05%',
  routerHops: 1,
  differentVenue: false,
  ...extra,
});

describe('median', () => {
  it('takes the middle of an odd-length set', () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it('averages the two middles of an even-length set', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it('is zero for no samples rather than NaN', () => {
    expect(median([])).toBe(0);
  });

  it('is not dragged by an outlier the way a mean would be', () => {
    const withOutlier = [1, 2, 3, 4, 10_000];
    expect(median(withOutlier)).toBe(3);
    const mean = withOutlier.reduce((a, b) => a + b, 0) / withOutlier.length;
    expect(mean).toBeGreaterThan(1_000);
  });

  it('does not mutate its input', () => {
    const xs = [3, 1, 2];
    median(xs);
    expect(xs).toEqual([3, 1, 2]);
  });
});

describe('percentile', () => {
  const xs = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

  it('returns the extremes at 0 and 100', () => {
    expect(percentile(xs, 0)).toBe(10);
    expect(percentile(xs, 100)).toBe(100);
  });

  it('is monotone in p', () => {
    let prev = -Infinity;
    for (let p = 0; p <= 100; p += 10) {
      const v = percentile(xs, p);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('handles a single sample and an empty set', () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([], 50)).toBe(0);
  });
});

describe('summarise', () => {
  it('counts wins, losses and ties without losing any sample', () => {
    const results = [sample(10), sample(-5), sample(0), sample(3), sample(-1)];
    const s = summarise(results);
    expect(s.samples).toBe(5);
    expect(s.wins).toBe(2);
    expect(s.losses).toBe(2);
    expect(s.ties).toBe(1);
    expect(s.wins + s.losses + s.ties).toBe(s.samples);
  });

  it('treats a zero edge as a tie, not a win', () => {
    // A tie means the router found the same fill. Counting it as a win would
    // inflate the headline win rate on every deep pair, where matching is the
    // expected outcome.
    const s = summarise([sample(0), sample(0), sample(1)]);
    expect(s.winRate).toBeCloseTo(1 / 3);
  });

  it('reports median win and median loss separately', () => {
    const s = summarise([sample(10), sample(30), sample(-4), sample(-20)]);
    expect(s.medianWinBps).toBe(20);
    expect(s.medianLossBps).toBe(-12);
  });

  it('survives an all-losses set without NaN', () => {
    const s = summarise([sample(-5), sample(-10)]);
    expect(s.winRate).toBe(0);
    expect(s.medianWinBps).toBe(0);
    expect(Number.isNaN(s.medianEdgeBps)).toBe(false);
  });

  it('returns a zeroed summary for no samples', () => {
    const s = summarise([]);
    expect(s.samples).toBe(0);
    expect(s.winRate).toBe(0);
    expect(s.medianEdgeBps).toBe(0);
  });

  it('counts multi-hop replays', () => {
    const s = summarise([sample(1, { routerHops: 2 }), sample(1), sample(2, { routerHops: 2 })]);
    expect(s.multiHopUsed).toBe(2);
  });

  it('p25 does not exceed p75', () => {
    const s = summarise([sample(-30), sample(-2), sample(4), sample(50), sample(9)]);
    expect(s.p25EdgeBps).toBeLessThanOrEqual(s.p75EdgeBps);
  });
});
