'use client';

import { useEffect, useMemo, useState } from 'react';
import { TOKENS, EXPLORER, type Token } from '@/lib/chain';
import { sig, addr } from '@/lib/format';
import { TokenSelect } from './TokenSelect';

type PoolRow = {
  family: 'v2' | 'v3' | 'aero';
  label: string;
  curve: string;
  tokenA: Token;
  tokenB: Token;
  pool: `0x${string}`;
  inventoryA: bigint;
  inventoryB: bigint;
  usedByMultiHop: boolean;
};

type Payload = {
  routesConsidered: number;
  multiHopRoutes: number;
  pools: PoolRow[];
};

export function VenueTable() {
  const [inSym, setInSym] = useState('WETH');
  const [outSym, setOutSym] = useState('USDC');
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    fetch(`/api/venues?in=${inSym}&out=${outSym}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((body) => {
        if (cancelled) return;
        if (body.error) {
          setError(body.error);
          return;
        }
        setData({
          routesConsidered: body.routesConsidered,
          multiHopRoutes: body.multiHopRoutes,
          pools: (body.pools as (Omit<PoolRow, 'inventoryA' | 'inventoryB'> & {
            inventoryA: string;
            inventoryB: string;
          })[]).map((p) => ({
            ...p,
            inventoryA: BigInt(p.inventoryA),
            inventoryB: BigInt(p.inventoryB),
          })),
        });
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [inSym, outSym]);

  const pools = useMemo(
    () => (data ? [...data.pools].sort((a, b) => a.label.localeCompare(b.label)) : []),
    [data],
  );

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Venues</h1>
        <p className="page-sub">
          Every pool the router considered for this pair — found by asking each factory, not from
          a hardcoded list — including the pools that only appear in the middle of a two-hop
          route.
        </p>
      </div>

      <section className="section">
        <div className="section-head">
          <h2 className="sec-label">Pool inventory</h2>
          <div className="section-meta flex items-center gap-2">
            {data && (
              <span className="mut" style={{ marginRight: 10 }}>
                {data.routesConsidered} routes · {data.multiHopRoutes} multi-hop
              </span>
            )}
            <TokenSelect value={inSym} onChange={setInSym} exclude={outSym} tokens={TOKENS} />
            <span className="mut">/</span>
            <TokenSelect value={outSym} onChange={setOutSym} exclude={inSym} tokens={TOKENS} />
          </div>
        </div>

        {error && <div className="err">{error}</div>}
        {!data && !error && <div className="empty">Scanning factories…</div>}

        {data && pools.length === 0 && (
          <div className="empty">No pools found for {inSym}/{outSym}.</div>
        )}

        {pools.length > 0 && (
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>Venue</th>
                  <th>Pair</th>
                  <th>Curve</th>
                  <th>Pool</th>
                  <th className="num">Inventory</th>
                </tr>
              </thead>
              <tbody>
                {pools.map((p) => (
                  <tr key={p.pool}>
                    <td>
                      {p.label}
                      {p.usedByMultiHop && (
                        <span className="badge b-mut" style={{ marginLeft: 8 }}>
                          mid-route
                        </span>
                      )}
                    </td>
                    <td className="mono">
                      {p.tokenA.symbol}/{p.tokenB.symbol}
                    </td>
                    <td className="mut">{p.curve}</td>
                    <td className="mono">
                      <a href={`${EXPLORER}/address/${p.pool}`} target="_blank" rel="noreferrer">
                        {addr(p.pool)}
                      </a>
                    </td>
                    <td className="num mono">
                      {sig(p.inventoryA, p.tokenA, 5)} {p.tokenA.symbol}
                      <br />
                      <span className="mut">
                        {sig(p.inventoryB, p.tokenB, 5)} {p.tokenB.symbol}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="mt-3" style={{ fontSize: 12.5, color: 'var(--ink-3)', lineHeight: 1.55 }}>
          Inventory is the pool contract&rsquo;s ERC-20 balance, not{' '}
          <code className="mono">getReserves</code>. A V3 pool has no reserves function and a
          stable pool&rsquo;s reserves are not comparable to a constant-product pool&rsquo;s, so
          balances are the one figure that means the same thing in every row. For a concentrated
          pool, only the fraction of that balance sitting in range is available to the next trade
          — which is exactly why the router quotes rather than ranking by size.
        </p>
      </section>
    </>
  );
}
