'use client';

import { useEffect, useRef } from 'react';

/**
 * Distribution of router edge across replayed trades.
 *
 * A histogram rather than a single median, because the median is the least
 * interesting thing about this result. What a reader should be able to see at a
 * glance is the shape: how much of the mass sits left of zero, how fat the
 * losing tail is, and whether the wins are a broad shift or a few outliers
 * dragging an average around. A headline number can hide all three.
 */
export function EdgeHistogram({ edges }: { edges: number[] }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || edges.length === 0) return;

    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(rect.width * dpr);
      canvas.height = Math.floor(rect.height * dpr);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, rect.width, rect.height);

      const css = getComputedStyle(document.documentElement);
      const up = css.getPropertyValue('--up').trim() || '#4fd1b8';
      const down = css.getPropertyValue('--down').trim() || '#e8756d';
      const ink3 = css.getPropertyValue('--ink-3').trim() || '#6e807b';
      const rule = css.getPropertyValue('--rule').trim() || '#1c2a27';

      const pad = { l: 34, r: 12, t: 12, b: 26 };
      const w = rect.width - pad.l - pad.r;
      const h = rect.height - pad.t - pad.b;
      if (w <= 0 || h <= 0) return;

      // Clip the axis to the 5th–95th percentile. A single -900bp sample from a
      // near-empty pool otherwise compresses every real observation into one bar.
      const sorted = [...edges].sort((a, b) => a - b);
      const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
      let lo = Math.min(at(5), -5);
      let hi = Math.max(at(95), 5);
      if (hi - lo < 10) {
        lo -= 5;
        hi += 5;
      }

      const BINS = 21;
      const bins = new Array(BINS).fill(0);
      let clippedLow = 0;
      let clippedHigh = 0;
      for (const e of edges) {
        if (e < lo) {
          clippedLow++;
          bins[0]++;
          continue;
        }
        if (e > hi) {
          clippedHigh++;
          bins[BINS - 1]++;
          continue;
        }
        const i = Math.min(BINS - 1, Math.floor(((e - lo) / (hi - lo)) * BINS));
        bins[i]++;
      }
      const peak = Math.max(...bins, 1);

      const x = (v: number) => pad.l + ((v - lo) / (hi - lo)) * w;
      const barW = w / BINS;

      // zero line — the only reference that matters
      ctx.strokeStyle = rule;
      ctx.lineWidth = 1;
      const zx = Math.round(x(0)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(zx, pad.t);
      ctx.lineTo(zx, pad.t + h);
      ctx.stroke();

      bins.forEach((count, i) => {
        if (count === 0) return;
        const binCentre = lo + ((i + 0.5) / BINS) * (hi - lo);
        const bh = (count / peak) * h;
        ctx.fillStyle = binCentre >= 0 ? up : down;
        ctx.fillRect(pad.l + i * barW + 0.5, pad.t + h - bh, Math.max(1, barW - 1.5), bh);
      });

      ctx.fillStyle = ink3;
      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'center';
      for (const v of [lo, 0, hi]) {
        ctx.fillText(`${v > 0 ? '+' : ''}${Math.round(v)}`, x(v), pad.t + h + 16);
      }
      ctx.textAlign = 'left';
      ctx.fillText(`n=${edges.length}`, pad.l, pad.t + 9);
      if (clippedLow + clippedHigh > 0) {
        ctx.textAlign = 'right';
        ctx.fillText(
          `${clippedLow + clippedHigh} beyond axis`,
          pad.l + w,
          pad.t + 9,
        );
      }
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [edges]);

  return (
    <div className="chart-frame" style={{ height: 220 }}>
      <canvas ref={ref} />
    </div>
  );
}
