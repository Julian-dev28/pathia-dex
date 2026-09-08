'use client';

import { useEffect, useRef } from 'react';
import type { ApiVenue } from '@/lib/api';
import type { Token } from '@/lib/chain';

const SERIES = ['--accent', '--amber', '--up', '--ink-2', '--down'];

/**
 * Effective price against trade size, one line per venue.
 *
 * This is the chart the whole ladder exists to draw. A quote at one size tells
 * you where to route a single trade; the curve tells you *why*, and where the
 * answer changes — the crossing point between two venues is the size at which
 * a router should start splitting.
 *
 * Drawn by hand on a canvas rather than pulled from a chart library: five
 * polylines, two axes and a hairline grid do not justify 90kB, and a library's
 * default styling would fight the design system on every element.
 */
export function DepthChart({
  venues,
  tokenIn,
  tokenOut,
}: {
  venues: ApiVenue[];
  tokenIn: Token;
  tokenOut: Token;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;

    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      // The bitmap is scaled for the display; the CSS box is not, or the canvas
      // grows by the pixel ratio on every redraw.
      canvas.width = Math.floor(rect.width * dpr);
      canvas.height = Math.floor(rect.height * dpr);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, rect.width, rect.height);

      const css = getComputedStyle(document.documentElement);
      const ink3 = css.getPropertyValue('--ink-3').trim() || '#6e807b';
      const rule = css.getPropertyValue('--rule').trim() || '#1c2a27';

      const pad = { l: 58, r: 12, t: 12, b: 30 };
      const w = rect.width - pad.l - pad.r;
      const h = rect.height - pad.t - pad.b;
      if (w <= 0 || h <= 0) return;

      // Each point is (size in input units, effective price in output per input).
      const series = venues
        .map((v, i) => ({
          label: v.venue.label,
          color: css.getPropertyValue(SERIES[i % SERIES.length]).trim(),
          points: v.rungs
            .filter((r) => r.amountOut > 0n)
            .map((r) => ({
              x: Number(r.amountIn) / 10 ** tokenIn.decimals,
              y:
                Number(r.amountOut) /
                10 ** tokenOut.decimals /
                (Number(r.amountIn) / 10 ** tokenIn.decimals),
            }))
            .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && p.x > 0),
        }))
        .filter((s) => s.points.length > 1);

      if (series.length === 0) return;

      const xs = series.flatMap((s) => s.points.map((p) => p.x));
      const ys = series.flatMap((s) => s.points.map((p) => p.y));
      const xMin = Math.min(...xs);
      const xMax = Math.max(...xs);
      // Clamp the y-window to the top of the price range. A drained 20k-dollar
      // pool quotes a price two orders of magnitude below the real one, and
      // letting it set the axis flattens every venue that matters into one line.
      const yTop = Math.max(...ys);
      const yBottom = Math.max(Math.min(...ys), yTop * 0.55);

      const lx = (x: number) =>
        pad.l + ((Math.log(x) - Math.log(xMin)) / (Math.log(xMax) - Math.log(xMin) || 1)) * w;
      const ly = (y: number) => pad.t + h - ((y - yBottom) / (yTop - yBottom || 1)) * h;

      // grid + y labels
      ctx.strokeStyle = rule;
      ctx.fillStyle = ink3;
      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.lineWidth = 1;
      for (let i = 0; i <= 4; i++) {
        const y = yBottom + ((yTop - yBottom) * i) / 4;
        const py = Math.round(ly(y)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(pad.l, py);
        ctx.lineTo(pad.l + w, py);
        ctx.stroke();
        ctx.textAlign = 'right';
        ctx.fillText(y.toPrecision(6), pad.l - 8, py + 3);
      }

      // x labels at the ends and middle
      ctx.textAlign = 'center';
      for (const x of [xMin, Math.sqrt(xMin * xMax), xMax]) {
        ctx.fillText(
          x < 1 ? x.toPrecision(2) : x.toLocaleString('en-US', { maximumFractionDigits: 2 }),
          lx(x),
          pad.t + h + 18,
        );
      }

      for (const s of series) {
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        s.points.forEach((p, i) => (i === 0 ? ctx.moveTo(lx(p.x), ly(p.y)) : ctx.lineTo(lx(p.x), ly(p.y))));
        ctx.stroke();
      }
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [venues, tokenIn, tokenOut]);

  return (
    <div className="chart-frame">
      <canvas ref={ref} />
    </div>
  );
}
