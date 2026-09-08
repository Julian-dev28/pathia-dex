'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAccount, useReadContract, useSendTransaction, useWaitForTransactionReceipt } from 'wagmi';
import { TOKENS, bySymbol } from '@/lib/chain';
import { fetchQuote, type QuoteResponse } from '@/lib/api';
import { toBase, sig, bps, addr } from '@/lib/format';
import { buildSwap, approveTx, spenderFor, minOut, ERC20 } from '@/lib/execute';
import { Disclaimer } from './Disclaimer';

const SLIPPAGE_CHOICES = [10, 30, 50, 100];

export function Terminal() {
  const [inSym, setInSym] = useState('WETH');
  const [outSym, setOutSym] = useState('USDC');
  const [amount, setAmount] = useState('1');
  const [slippageBps, setSlippageBps] = useState(50);

  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tokenIn = useMemo(() => bySymbol(inSym), [inSym]);
  const tokenOut = useMemo(() => bySymbol(outSym), [outSym]);
  const amountIn = useMemo(() => toBase(amount, tokenIn), [amount, tokenIn]);

  const { address, isConnected } = useAccount();

  /**
   * Quotes are debounced and abortable. Typing an amount fires a request per
   * keystroke otherwise, and because responses can land out of order, a slow
   * early request would overwrite a fast later one with a stale price.
   */
  const abortRef = useRef<AbortController | null>(null);
  const runQuote = useCallback(async () => {
    abortRef.current?.abort();
    if (amountIn <= 0n || inSym === outSym) {
      setQuote(null);
      setError(inSym === outSym ? 'Pick two different tokens.' : null);
      return;
    }
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    try {
      const q = await fetchQuote(inSym, outSym, amount, ctrl.signal);
      if (!ctrl.signal.aborted) {
        setQuote(q);
        setError(null);
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      setError(e instanceof Error ? e.message : 'quote failed');
      setQuote(null);
    } finally {
      if (!ctrl.signal.aborted) setLoading(false);
    }
  }, [inSym, outSym, amount, amountIn]);

  useEffect(() => {
    const t = setTimeout(runQuote, 350);
    return () => clearTimeout(t);
  }, [runQuote]);

  // Re-quote on a timer so a price that has moved does not sit on screen
  // looking current. 12s is roughly six Base blocks.
  useEffect(() => {
    const t = setInterval(runQuote, 12_000);
    return () => clearInterval(t);
  }, [runQuote]);

  const execVenue = quote?.route.single.allocations[0]?.venue ?? null;
  const spender = execVenue ? spenderFor(execVenue) : undefined;

  const { data: balance } = useReadContract({
    address: tokenIn.address,
    abi: ERC20,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: !!address, refetchInterval: 15_000 },
  });

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: tokenIn.address,
    abi: ERC20,
    functionName: 'allowance',
    args: address && spender ? [address, spender] : undefined,
    query: { enabled: !!address && !!spender },
  });

  const needsApproval = allowance !== undefined && amountIn > 0n && (allowance as bigint) < amountIn;
  const insufficient = balance !== undefined && amountIn > (balance as bigint);

  const { sendTransaction, data: txHash, isPending, reset } = useSendTransaction();
  const { isLoading: mining, isSuccess: mined } = useWaitForTransactionReceipt({ hash: txHash });

  useEffect(() => {
    if (mined) {
      refetchAllowance();
      runQuote();
    }
  }, [mined, refetchAllowance, runQuote]);

  const onApprove = () => {
    if (!spender) return;
    reset();
    sendTransaction(approveTx(tokenIn, spender, amountIn));
  };

  const onSwap = () => {
    if (!execVenue || !address || !quote) return;
    reset();
    const floor = minOut(quote.route.single.amountOut, slippageBps);
    sendTransaction(buildSwap(execVenue, tokenIn, tokenOut, amountIn, floor, address));
  };

  const flip = () => {
    setInSym(outSym);
    setOutSym(inSym);
  };

  const route = quote?.route;
  const split = route?.split;
  const winning = (route?.netEdgeBps ?? 0) > 0;

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Route terminal</h1>
        <p className="page-sub">
          Every Base venue quoted directly from pool state, then split by marginal price. No
          aggregator sits between this page and the chain.
        </p>
      </div>

      <Disclaimer />

      <div className="row row-wide">
        {/* ── trade ─────────────────────────────────────────────────── */}
        <section className="section">
          <div className="section-head">
            <h2 className="sec-label">Trade</h2>
            <span className="section-meta">
              {loading ? 'quoting…' : quote ? `${quote.latencyMs} ms` : '—'}
            </span>
          </div>

          <div className="swap-grid">
            <div className="amount-field">
              <input
                className="amount-input"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.0"
                aria-label="Amount to sell"
              />
              <select
                className="token-select"
                value={inSym}
                onChange={(e) => setInSym(e.target.value)}
                aria-label="Token to sell"
              >
                {TOKENS.map((t) => (
                  <option key={t.symbol} value={t.symbol}>
                    {t.symbol}
                  </option>
                ))}
              </select>
            </div>

            <div className="flip-row">
              <button className="flip-btn" onClick={flip} title="Flip direction" aria-label="Flip direction">
                ⇅
              </button>
            </div>

            <div className="amount-field">
              {/* The executable number, not the solved one. Execution is
                  single-venue, so showing the split total here would quote the
                  user a fill they cannot get. The split's advantage is stated
                  beside the route, where it belongs. */}
              <span className="amount-input" style={{ color: quote ? 'var(--ink)' : 'var(--ink-3)' }}>
                {quote ? sig(quote.route.single.amountOut, tokenOut) : '0.0'}
              </span>
              <select
                className="token-select"
                value={outSym}
                onChange={(e) => setOutSym(e.target.value)}
                aria-label="Token to buy"
              >
                {TOKENS.map((t) => (
                  <option key={t.symbol} value={t.symbol}>
                    {t.symbol}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="mt-3 flex items-center gap-2" style={{ justifyContent: 'space-between' }}>
            <span className="sec-label">Max slippage</span>
            <div className="seg">
              {SLIPPAGE_CHOICES.map((s) => (
                <button
                  key={s}
                  className={`range-btn${slippageBps === s ? ' on' : ''}`}
                  onClick={() => setSlippageBps(s)}
                >
                  {(s / 100).toFixed(2)}%
                </button>
              ))}
            </div>
          </div>

          {error && <div className="err mt-3">{error}</div>}

          <div className="mt-3">
            {!isConnected ? (
              <button className="btn-primary" disabled>
                Connect a wallet to trade
              </button>
            ) : insufficient ? (
              <button className="btn-primary" disabled>
                Insufficient {tokenIn.symbol}
              </button>
            ) : needsApproval ? (
              <button className="btn-primary" onClick={onApprove} disabled={isPending || mining}>
                {isPending || mining ? 'Approving…' : `Approve ${sig(amountIn, tokenIn)} ${tokenIn.symbol}`}
              </button>
            ) : (
              <button
                className="btn-primary"
                onClick={onSwap}
                disabled={!quote || isPending || mining || amountIn <= 0n}
              >
                {isPending || mining
                  ? 'Confirming…'
                  : execVenue
                    ? `Swap via ${execVenue.label}`
                    : 'Swap'}
              </button>
            )}
          </div>

          {quote && (
            <div className="mt-3" style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>
              Minimum received{' '}
              <span className="mono">
                {sig(minOut(quote.route.single.amountOut, slippageBps), tokenOut)} {tokenOut.symbol}
              </span>{' '}
              — enforced on-chain by {execVenue?.label}, not by this page.
            </div>
          )}

          {txHash && (
            <div className="mt-2" style={{ fontSize: 12.5 }}>
              <a href={`https://basescan.org/tx/${txHash}`} target="_blank" rel="noreferrer">
                {mined ? 'Confirmed' : 'Pending'} — {addr(txHash)} on Basescan
              </a>
            </div>
          )}

          {isConnected && balance !== undefined && (
            <div className="mt-2" style={{ fontSize: 12, color: 'var(--ink-3)' }}>
              Balance {sig(balance as bigint, tokenIn)} {tokenIn.symbol}
            </div>
          )}
        </section>

        {/* ── route ─────────────────────────────────────────────────── */}
        <section className="section">
          <div className="section-head">
            <h2 className="sec-label">Solved route</h2>
            <span className="section-meta">{split?.allocations.length ?? 0} venues</span>
          </div>

          {!split || split.allocations.length === 0 ? (
            <div className="empty">Enter an amount to solve a route.</div>
          ) : (
            <>
              <div className={`verdict ${winning ? 'win' : 'flat'}`}>
                <span>
                  {winning ? 'Splitting wins' : 'Single venue wins'}
                </span>
                <span className="mono">
                  {bps(route!.edgeBps)} gross · {bps(route!.netEdgeBps)} net of gas
                </span>
                <span className="mut" style={{ marginLeft: 'auto' }}>
                  vs. best single venue
                </span>
              </div>

              <div className="alloc-bar mt-3">
                {split.allocations.map((a, i) => (
                  <div
                    key={a.venue.id}
                    className={`alloc-seg vc-${i % 5}`}
                    style={{ width: `${a.share}%` }}
                    title={`${a.venue.label} ${a.share.toFixed(1)}%`}
                  />
                ))}
              </div>

              <div className="mt-3">
                {split.allocations.map((a, i) => (
                  <div className="route-row" key={a.venue.id}>
                    <span>
                      <span className={`swatch vc-${i % 5}`} />
                      {a.venue.label}
                    </span>
                    <span className="mono">
                      {a.share.toFixed(1)}% · {sig(a.amountOut, tokenOut)} {tokenOut.symbol}
                    </span>
                  </div>
                ))}
              </div>

              <p className="mt-3" style={{ fontSize: 12.5, color: 'var(--ink-3)', lineHeight: 1.55 }}>
                The split above is the solver&rsquo;s answer. Execution goes to the single best
                venue, because splitting atomically needs a router contract holding the
                intermediate balance — that contract is written and fork-tested in{' '}
                <code className="mono">contracts/</code>, and is not deployed. Shipping an
                unaudited contract that touches user funds to make a{' '}
                {Math.abs(route!.netEdgeBps).toFixed(1)}bp improvement is a bad trade.
              </p>
            </>
          )}
        </section>
      </div>

      {/* ── venue comparison ────────────────────────────────────────── */}
      <section className="section">
        <div className="section-head">
          <h2 className="sec-label">Every venue, this size</h2>
          <span className="section-meta">
            {quote?.gas.gasAdjusted
              ? `gas ${(Number(quote.gas.gasPriceWei) / 1e9).toFixed(4)} gwei`
              : 'gas conversion unavailable'}
          </span>
        </div>

        {!quote ? (
          <div className="empty">No quote yet.</div>
        ) : (
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>Venue</th>
                  <th className="num">Output</th>
                  <th className="num">Price</th>
                  <th className="num">vs. best</th>
                  <th className="num">Gas</th>
                </tr>
              </thead>
              <tbody>
                {[...quote.venues]
                  .sort((a, b) => (a.amountOutAtFull > b.amountOutAtFull ? -1 : 1))
                  .map((v) => {
                    const best = quote.route.single.amountOut;
                    const deltaBps =
                      best > 0n
                        ? Number(((v.amountOutAtFull - best) * 10_000n) / best)
                        : 0;
                    const price =
                      Number(v.amountOutAtFull) /
                      10 ** tokenOut.decimals /
                      (Number(amountIn) / 10 ** tokenIn.decimals);
                    return (
                      <tr key={v.venue.id}>
                        <td>{v.venue.label}</td>
                        <td className="num mono">{sig(v.amountOutAtFull, tokenOut)}</td>
                        <td className="num mono">{price.toFixed(4)}</td>
                        <td className={`num mono ${deltaBps < 0 ? 'dn' : 'mut'}`}>
                          {deltaBps === 0 ? 'best' : bps(deltaBps)}
                        </td>
                        <td className="num mono mut">{v.gasEstimate.toString()}</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
