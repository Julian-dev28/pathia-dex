'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useAccount,
  useReadContract,
  useSendTransaction,
  useWaitForTransactionReceipt,
  useChainId,
} from 'wagmi';
import { base } from 'wagmi/chains';
import { TOKENS, bySymbol, EXPLORER } from '@/lib/chain';
import { fetchQuote, type QuoteResponse, type ApiVenue } from '@/lib/api';
import { toBase, sig, bps, addr } from '@/lib/format';
import { buildSwap, approveTx, spenderFor, minOut, routeLabel, ERC20 } from '@/lib/execute';
import { Disclaimer } from './Disclaimer';
import { TokenSelect } from './TokenSelect';
import { RoutePath } from './RoutePath';

const SLIPPAGE_CHOICES = [10, 30, 50, 100];

/** Below this, the trade is loud enough that the user must acknowledge it. */
const HIGH_IMPACT_BPS = -300;

/** Impact worse than this is almost certainly a mistake, not a trade. */
const SEVERE_IMPACT_BPS = -1_000;

/**
 * Price impact of the executed route, in basis points.
 *
 * Measured as the full-size price against the price of the smallest rung on the
 * same curve — the smallest rung is the closest thing to a mid price we have,
 * and it comes from the same pool at the same block, so no external oracle is
 * involved.
 */
function impactBps(v: ApiVenue | undefined): number | null {
  if (!v || v.rungs.length < 2) return null;
  const first = v.rungs[0];
  const last = v.rungs[v.rungs.length - 1];
  if (first.amountIn === 0n || last.amountIn === 0n) return null;
  const pxSmall = Number(first.amountOut) / Number(first.amountIn);
  const pxFull = Number(last.amountOut) / Number(last.amountIn);
  if (!Number.isFinite(pxSmall) || pxSmall === 0) return null;
  return ((pxFull - pxSmall) / pxSmall) * 10_000;
}

export function Terminal() {
  const [inSym, setInSym] = useState('WETH');
  const [outSym, setOutSym] = useState('USDC');
  const [amount, setAmount] = useState('1');
  const [slippageBps, setSlippageBps] = useState(50);
  const [acknowledgedImpact, setAcknowledgedImpact] = useState(false);

  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const tokenIn = useMemo(() => bySymbol(inSym), [inSym]);
  const tokenOut = useMemo(() => bySymbol(outSym), [outSym]);
  const amountIn = useMemo(() => toBase(amount, tokenIn), [amount, tokenIn]);

  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const wrongChain = isConnected && chainId !== base.id;

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
      setError(null);
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

  // Drives the staleness countdown without re-quoting.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);

  // A new pair or size invalidates any acknowledgement of the old one.
  useEffect(() => setAcknowledgedImpact(false), [inSym, outSym, amount]);

  const route = quote?.route;
  const execVenue = route?.single.allocations[0]?.venue ?? null;
  const execApiVenue = quote?.venues.find((v) => v.venue.id === execVenue?.id);
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

  const { sendTransaction, data: txHash, isPending, error: txError, reset } = useSendTransaction();
  const { isLoading: mining, isSuccess: mined } = useWaitForTransactionReceipt({ hash: txHash });

  useEffect(() => {
    if (mined) {
      refetchAllowance();
      runQuote();
    }
  }, [mined, refetchAllowance, runQuote]);

  const impact = impactBps(execApiVenue);
  const highImpact = impact !== null && impact < HIGH_IMPACT_BPS;
  const severeImpact = impact !== null && impact < SEVERE_IMPACT_BPS;

  const secondsLeft = quote ? Math.max(0, Math.ceil((quote.expiresAt - now) / 1000)) : 0;
  const expired = !!quote && secondsLeft === 0;

  const onApprove = () => {
    if (!spender) return;
    reset();
    sendTransaction(approveTx(tokenIn, spender, amountIn));
  };

  const onSwap = () => {
    if (!execVenue || !address || !quote || expired) return;
    reset();
    const floor = minOut(quote.route.single.amountOut, slippageBps);
    sendTransaction(buildSwap(execVenue, amountIn, floor, address));
  };

  const flip = () => {
    setInSym(outSym);
    setOutSym(inSym);
  };

  const setMax = () => {
    if (balance === undefined) return;
    // No gas reserve is subtracted: the input is always an ERC-20, never native
    // ETH, so spending all of it still leaves the wallet able to pay fees.
    setAmount(sig(balance as bigint, tokenIn, 12).replace(/,/g, ''));
  };

  const split = route?.split;
  const splitWins = (route?.netEdgeBps ?? 0) > 0 && route?.chosen === 'split';

  const swapBlocked =
    !quote || expired || amountIn <= 0n || (highImpact && !acknowledgedImpact) || wrongChain;

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Route terminal</h1>
        <p className="page-sub">
          Every Base venue quoted directly from pool state — direct pools and two-hop routes
          alike — then split by marginal price. No aggregator sits between this page and the
          chain.
        </p>
      </div>

      <Disclaimer />

      <div className="row row-wide">
        {/* ── trade ─────────────────────────────────────────────────── */}
        <section className="section">
          <div className="section-head">
            <h2 className="sec-label">Trade</h2>
            <span className="section-meta">
              {loading ? (
                'quoting…'
              ) : quote ? (
                <>
                  block {quote.blockNumber.toString()} · {quote.latencyMs} ms
                  {quote.cached && ' · cached'}
                </>
              ) : (
                '—'
              )}
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
              <TokenSelect
                value={inSym}
                onChange={setInSym}
                tokens={TOKENS}
                exclude={outSym}
                label={`Selling ${inSym}`}
              />
            </div>

            {isConnected && balance !== undefined && (
              <div className="balance-row">
                <span className="mut">
                  Balance {sig(balance as bigint, tokenIn)} {tokenIn.symbol}
                </span>
                <button className="link-btn" onClick={setMax} type="button">
                  Max
                </button>
              </div>
            )}

            <div className="flip-row">
              <button
                className="flip-btn"
                onClick={flip}
                title="Flip direction"
                aria-label="Flip direction"
                type="button"
              >
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
              <TokenSelect
                value={outSym}
                onChange={setOutSym}
                tokens={TOKENS}
                exclude={inSym}
                label={`Buying ${outSym}`}
              />
            </div>
          </div>

          {execVenue && (
            <div className="mt-3 route-summary">
              <RoutePath venue={execVenue} />
              <span className="mut">via {execVenue.label}</span>
            </div>
          )}

          <div className="mt-3 flex items-center gap-2" style={{ justifyContent: 'space-between' }}>
            <span className="sec-label">Max slippage</span>
            <div className="seg">
              {SLIPPAGE_CHOICES.map((s) => (
                <button
                  key={s}
                  className={`range-btn${slippageBps === s ? ' on' : ''}`}
                  onClick={() => setSlippageBps(s)}
                  type="button"
                >
                  {(s / 100).toFixed(2)}%
                </button>
              ))}
            </div>
          </div>

          {error && (
            <div className="err mt-3">
              {error}{' '}
              <button className="link-btn" onClick={runQuote} type="button">
                Retry
              </button>
            </div>
          )}

          {highImpact && (
            <label className={`impact-warn mt-3 ${severeImpact ? 'severe' : ''}`}>
              <input
                type="checkbox"
                checked={acknowledgedImpact}
                onChange={(e) => setAcknowledgedImpact(e.target.checked)}
              />
              <span>
                <strong>
                  Price impact {impact !== null ? (impact / 100).toFixed(2) : '—'}%.
                </strong>{' '}
                {severeImpact
                  ? 'This trade is large relative to every pool that quotes it, and most of the value is lost to impact. Check the size before continuing.'
                  : 'This trade moves the pool noticeably. Continue only if that is intended.'}
              </span>
            </label>
          )}

          <div className="mt-3">
            {!isConnected ? (
              <button className="btn-primary" disabled type="button">
                Connect a wallet to trade
              </button>
            ) : wrongChain ? (
              <button className="btn-primary" disabled type="button">
                Switch to Base to trade
              </button>
            ) : insufficient ? (
              <button className="btn-primary" disabled type="button">
                Insufficient {tokenIn.symbol}
              </button>
            ) : needsApproval ? (
              <button
                className="btn-primary"
                onClick={onApprove}
                disabled={isPending || mining}
                type="button"
              >
                {isPending || mining
                  ? 'Approving…'
                  : `Approve ${sig(amountIn, tokenIn)} ${tokenIn.symbol}`}
              </button>
            ) : (
              <button
                className="btn-primary"
                onClick={onSwap}
                disabled={swapBlocked || isPending || mining}
                type="button"
              >
                {isPending
                  ? 'Confirm in wallet…'
                  : mining
                    ? 'Swapping…'
                    : expired
                      ? 'Quote expired — refreshing'
                      : execVenue
                        ? `Swap via ${execVenue.label}`
                        : 'Swap'}
              </button>
            )}
          </div>

          {quote && (
            <div className="mt-3 fineprint">
              <div>
                Minimum received{' '}
                <span className="mono">
                  {sig(minOut(quote.route.single.amountOut, slippageBps), tokenOut)}{' '}
                  {tokenOut.symbol}
                </span>{' '}
                — enforced on-chain by {execVenue?.label}, not by this page.
              </div>
              <div className={expired ? 'dn' : 'mut'}>
                {expired
                  ? 'Quote expired. Re-quoting before this can be signed.'
                  : `Quote good for ${secondsLeft}s`}
              </div>
            </div>
          )}

          {txError && (
            <div className="err mt-2">
              {/* Wallet errors arrive as multi-paragraph dumps; the first line
                  is the part a human can act on. */}
              {txError.message.split('\n')[0]}
            </div>
          )}

          {txHash && (
            <div className={`tx-row mt-2 ${mined ? 'ok' : ''}`}>
              <span>{mined ? 'Confirmed' : 'Pending'}</span>
              <a href={`${EXPLORER}/tx/${txHash}`} target="_blank" rel="noreferrer">
                {addr(txHash)} on Basescan
              </a>
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
              <div className={`verdict ${splitWins ? 'win' : 'flat'}`}>
                <span>{splitWins ? 'Splitting wins' : 'Single venue wins'}</span>
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
                      {a.venue.hops.length > 1 && (
                        <span className="badge b-hop" style={{ marginLeft: 7 }}>
                          {a.venue.hops.length} hops
                        </span>
                      )}
                      <div style={{ marginTop: 3 }}>
                        <RoutePath venue={a.venue} />
                      </div>
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
          <h2 className="sec-label">Every route, this size</h2>
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
                  <th>Route</th>
                  <th>Path</th>
                  <th className="num">Output</th>
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
                      best > 0n ? Number(((v.amountOutAtFull - best) * 10_000n) / best) : 0;
                    return (
                      <tr key={v.venue.id}>
                        <td>{v.venue.label}</td>
                        <td>
                          <RoutePath venue={v.venue} />
                        </td>
                        <td className="num mono">{sig(v.amountOutAtFull, tokenOut)}</td>
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
        <p className="mt-2" style={{ fontSize: 12, color: 'var(--ink-3)' }}>
          {quote?.venues.filter((v) => v.multiHop).length ?? 0} of {quote?.venues.length ?? 0}{' '}
          routes shown pass through an intermediate token. A route only appears here if its pools
          quoted a non-zero output at this size.
        </p>
      </section>
    </>
  );
}
