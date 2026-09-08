import { formatUnits, parseUnits } from 'viem';
import type { Token } from './chain';

export const toBase = (human: string, t: Token): bigint => {
  const cleaned = human.trim().replace(/,/g, '');
  if (!cleaned || !/^\d*\.?\d*$/.test(cleaned)) return 0n;
  try {
    return parseUnits(cleaned as `${number}`, t.decimals);
  } catch {
    return 0n;
  }
};

export const fromBase = (v: bigint, t: Token): string => formatUnits(v, t.decimals);

/**
 * Display amounts with a fixed number of significant figures rather than a
 * fixed number of decimals: 6 decimals is noise on a WETH balance and total
 * truncation on a cbBTC one.
 */
export const sig = (v: bigint, t: Token, figures = 6): string => {
  const n = Number(formatUnits(v, t.decimals));
  if (!Number.isFinite(n) || n === 0) return '0';
  if (n >= 1) {
    const whole = Math.floor(Math.log10(n)) + 1;
    return n.toLocaleString('en-US', { maximumFractionDigits: Math.max(0, figures - whole) });
  }
  return n.toPrecision(figures).replace(/0+$/, '').replace(/\.$/, '');
};

export const bps = (v: number): string => `${v >= 0 ? '+' : ''}${v.toFixed(1)} bp`;

export const pct = (v: number): string => `${v.toFixed(2)}%`;

export const addr = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** JSON has no bigint. Route responses are deep, so this walks the whole tree. */
export const jsonSafe = <T>(v: T): unknown => {
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, jsonSafe(x)]));
  }
  return v;
};
