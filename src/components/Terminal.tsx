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
import { toBase, fromBase, sig, bps, addr } from '@/lib/format';
import { buildSwap, approveTx, spenderFor, minOut, ERC20 } from '@/lib/execute';
import { TokenSelect } from './TokenSelect';
import { RoutePath } from './RoutePath';
import { LiveTape } from './LiveTape';
import { AccountPanel } from './AccountPanel';
import {
  Card,
  Answer,
  Reveal,
  Chip,
  Suggest,
  Empty,
  ErrorNote,
  Loading,
  Segmented,
  useFocusMode,
} from './ui';

const SLIPPAGE_CHOICES = [10, 30, 50, 100];
const HIGH_IMPACT_BPS = -300;
const SEVERE_IMPACT_BPS = -1_000;

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

/**
 * The trade page.
 *
 * Restructured around one question at a time. This used to be two dense columns
 * plus three tables, all visible at once, with the button somewhere in the
 * middle and fine print competing with it for attention. It is now a short
 * numbered sequence — what you pay, what you get, the one risk worth acting on,
 * then the button — with everything else collapsed underneath.
 *
 * The rule the layout enforces: **nothing sits between the number and the
 * button.** Every explanation that used to live inline is now a closed panel,
 * so the reasoning is still there for anyone who wants it and in nobody's way
 * if they do not.
 */
export function Terminal() {
  const [inSym, setInSym] = useState('WETH');
  const [outSym, setOutSym] = useState('USDC');
  const [amount, setAmount] = useState('1');
  const [slippageBps, setSlippageBps] = useState(50);
  const [acknowledgedImpact, setAcknowledgedImpact] = useState(false);
  const [focus, toggleFocus] = useFocusMode();

  const [advice, setAdvice] = useState<{
    recommendedBps: number;
    confidence: 'high' | 'medium' | 'low';
    savedVsDefaultBps: number;
    driftP95Bps: number;
  } | null>(null);

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

  useEffect(() => {
    const t = setInterval(runQuote, 12_000);
    return () => clearInterval(t);
  }, [runQuote]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => setAcknowledgedImpact(false), [inSym, outSym, amount]);

  // Slippage advice arrives late and never blocks the form. Nothing here
  // changes the tolerance on the user's behalf — it offers, they apply.
  useEffect(() => {
    let cancelled = false;
    setAdvice(null);
    if (amountIn <= 0n || inSym === outSym) return;
    const t = setTimeout(() => {
      fetch(
        `/api/analyze?in=${inSym}&out=${outSym}&amount=${encodeURIComponent(amount)}&slippage=50`,
        { cache: 'no-store' },
      )
        .then((r) => r.json())
        .then((b) => {
          if (!cancelled && !b.error && b.recommendation) setAdvice(b.recommendation);
        })
        .catch(() => {
          /* advice is optional; the form does not depend on it */
        });
    }, 900);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [inSym, outSym, amount, amountIn]);

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

  const floor = quote ? minOut(quote.route.single.amountOut, slippageBps) : 0n;
  const exposure = quote ? quote.route.single.amountOut - floor : 0n;

  const onApprove = () => {
    if (!spender) return;
    reset();
    sendTransaction(approveTx(tokenIn, spender, amountIn));
  };

  const onSwap = () => {
    if (!execVenue || !address || !quote || expired) return;
    reset();
    sendTransaction(buildSwap(execVenue, amountIn, floor, address));
  };

  const blocked =
    !quote || expired || amountIn <= 0n || (highImpact && !acknowledgedImpact) || wrongChain;

  /** One line that is always true about what the button will do next. */
  const buttonLabel = (): string => {
    if (!isConnected) return 'Connect a wallet';
    if (wrongChain) return 'Switch to Base';
    if (insufficient) return `Not enough ${tokenIn.symbol}`;
    if (needsApproval) return isPending || mining ? 'Approving…' : `Approve ${tokenIn.symbol}`;
    if (isPending) return 'Confirm in your wallet…';
    if (mining) return 'Swapping…';
    if (expired) return 'Refreshing price…';
    if (highImpact && !acknowledgedImpact) return 'Confirm the price impact above';
    return `Swap ${tokenIn.symbol} for ${tokenOut.symbol}`;
  };

  return (
    <>
      <div className="c-tradehead">
        <h1 className="c-pagetitle">Trade</h1>
        <button className="c-ghost" type="button" onClick={toggleFocus} aria-pressed={focus}>
          {focus ? 'Show details' : 'Hide details'}
        </button>
      </div>

      {/* ── 1 · what you pay ────────────────────────────────────────── */}
      <Card title="You pay" step={1}>
        <div className="c-field">
          <input
            className="c-amount"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.0"
            aria-label={`Amount of ${tokenIn.symbol} to sell`}
          />
          <TokenSelect value={inSym} onChange={setInSym} tokens={TOKENS} exclude={outSym} />
        </div>

        <div className="c-field-foot">
          {isConnected && balance !== undefined ? (
            <>
              <span>
                Balance {sig(balance as bigint, tokenIn)} {tokenIn.symbol}
              </span>
              <button
                className="c-ghost"
                type="button"
                onClick={() => setAmount(fromBase(balance as bigint, tokenIn))}
              >
                Use max
              </button>
            </>
          ) : (
            <span>Connect a wallet to see your balance</span>
          )}
          <button
            className="c-ghost"
            type="button"
            onClick={() => {
              setInSym(outSym);
              setOutSym(inSym);
            }}
          >
            ⇅ Flip
          </button>
        </div>
      </Card>

      {/* ── 2 · what you get ────────────────────────────────────────── */}
      <Card
        title="You receive"
        step={2}
        meta={quote ? <span className="mono">block {quote.blockNumber.toString()}</span> : undefined}
      >
        {loading && !quote ? (
          <Loading rows={2} />
        ) : error ? (
          <ErrorNote onRetry={runQuote}>{error}</ErrorNote>
        ) : !quote ? (
          <Empty>Enter an amount above.</Empty>
        ) : (
          <>
            <Answer
              label={`${tokenOut.symbol} received`}
              value={sig(quote.route.single.amountOut, tokenOut)}
              size="xl"
              note={
                execVenue ? (
                  <>
                    via {execVenue.label} · <RoutePath venue={execVenue} />
                  </>
                ) : undefined
              }
            />

            <div className="c-guarantee">
              <span>
                Guaranteed minimum{' '}
                <strong className="mono">
                  {sig(floor, tokenOut)} {tokenOut.symbol}
                </strong>
              </span>
              <Chip tone={expired ? 'bad' : 'mut'}>
                {expired ? 'price expired' : `good for ${secondsLeft}s`}
              </Chip>
            </div>
          </>
        )}
      </Card>

      {/* ── 3 · the one risk worth acting on ────────────────────────── */}
      <Card
        title="Slippage"
        step={3}
        tone={highImpact ? (severeImpact ? 'bad' : 'warn') : 'default'}
        meta={
          quote ? (
            <span>
              {sig(exposure, tokenOut)} {tokenOut.symbol} at risk
            </span>
          ) : undefined
        }
      >
        <Segmented
          label="Maximum slippage"
          value={slippageBps}
          onChange={setSlippageBps}
          options={SLIPPAGE_CHOICES.map((s) => ({ value: s, label: `${(s / 100).toFixed(2)}%` }))}
        />

        {advice && advice.recommendedBps !== slippageBps && (
          <Suggest
            action={`Use ${(advice.recommendedBps / 100).toFixed(2)}%`}
            onAction={() => setSlippageBps(advice.recommendedBps)}
          >
            {advice.confidence === 'low' ? (
              <>
                Too few recent trades here to measure.{' '}
                {(advice.recommendedBps / 100).toFixed(2)}% is the safe default.
              </>
            ) : (
              <>
                This pair moved <strong>{advice.driftP95Bps.toFixed(1)} bp</strong> or less in 95%
                of recent blocks. <strong>{(advice.recommendedBps / 100).toFixed(2)}%</strong>{' '}
                covers it.
              </>
            )}
          </Suggest>
        )}

        {highImpact && (
          <label className={`c-ack${severeImpact ? ' severe' : ''}`}>
            <input
              type="checkbox"
              checked={acknowledgedImpact}
              onChange={(e) => setAcknowledgedImpact(e.target.checked)}
            />
            <span>
              <strong>This trade moves the price {((impact ?? 0) / 100).toFixed(2)}%.</strong>{' '}
              {severeImpact
                ? 'Most of its value is lost to impact. Check the size.'
                : 'Continue only if that is intended.'}
            </span>
          </label>
        )}

        <Reveal summary="What does slippage actually cost me?">
          <p>
            Your tolerance is not a safety margin — it is a standing offer. Someone can push the
            pool until you receive exactly your minimum and keep the difference, so the gap between
            the quote and your floor is the most they can take. Right now that gap is{' '}
            <strong className="mono">
              {sig(exposure, tokenOut)} {tokenOut.symbol}
            </strong>
            .
          </p>
          <p>
            The floor itself is enforced on-chain by {execVenue?.label ?? 'the venue'}, not by this
            page. If the price moves past it, the trade reverts rather than filling badly.
          </p>
        </Reveal>
      </Card>

      {/* ── the action ──────────────────────────────────────────────── */}
      <button
        className="c-go"
        onClick={needsApproval ? onApprove : onSwap}
        disabled={
          !isConnected ||
          insufficient ||
          (needsApproval ? isPending || mining : blocked || isPending || mining)
        }
        type="button"
      >
        {buttonLabel()}
      </button>

      {txError && <ErrorNote>{txError.message.split('\n')[0]}</ErrorNote>}

      {txHash && (
        <div className={`c-tx${mined ? ' ok' : ''}`}>
          <span>{mined ? '✓ Confirmed' : 'Pending…'}</span>
          <a href={`${EXPLORER}/tx/${txHash}`} target="_blank" rel="noreferrer">
            {addr(txHash)} on Basescan
          </a>
        </div>
      )}

      {/* ── everything else, below the fold and closed ──────────────── */}
      {!focus && quote && route && (
        <div className="c-secondary">
          <Card
            title="Could a split do better?"
            meta={
              route.chosen === 'split' ? (
                <Chip tone="good">yes, {bps(route.netEdgeBps)}</Chip>
              ) : (
                <Chip tone="mut">no</Chip>
              )
            }
          >
            {route.chosen === 'split' ? (
              <>
                <div className="c-alloc">
                  {route.split.allocations.map((a, i) => (
                    <div
                      key={a.venue.id}
                      className={`c-alloc-seg vc-${i % 5}`}
                      style={{ width: `${a.share}%` }}
                      title={`${a.venue.label} ${a.share.toFixed(1)}%`}
                    />
                  ))}
                </div>
                <ul className="c-list">
                  {route.split.allocations.map((a, i) => (
                    <li key={a.venue.id}>
                      <span className={`swatch vc-${i % 5}`} />
                      <span>{a.venue.label}</span>
                      <span className="mono">{a.share.toFixed(0)}%</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <Empty>One venue is the best answer at this size.</Empty>
            )}

            <Reveal summary="Why isn't the split executed?">
              <p>
                Splitting atomically needs a router contract that holds the intermediate balance
                mid-trade. That contract is written and fork-tested in{' '}
                <code>contracts/SplitRouter.sol</code> but deliberately not deployed — shipping
                unaudited code that takes custody to capture a few basis points is a bad trade.
              </p>
            </Reveal>
          </Card>

          <Card title="Every route" meta={`${quote.venues.length} quoted`}>
            <div className="c-scroll">
              <table className="c-table">
                <thead>
                  <tr>
                    <th>Route</th>
                    <th className="num">Receives</th>
                    <th className="num">vs best</th>
                  </tr>
                </thead>
                <tbody>
                  {[...quote.venues]
                    .sort((a, b) => (a.amountOutAtFull > b.amountOutAtFull ? -1 : 1))
                    .map((v) => {
                      const best = quote.route.single.amountOut;
                      const delta =
                        best > 0n ? Number(((v.amountOutAtFull - best) * 10_000n) / best) : 0;
                      return (
                        <tr key={v.venue.id}>
                          <td>
                            {v.venue.label}
                            <div>
                              <RoutePath venue={v.venue} />
                            </div>
                          </td>
                          <td className="num mono">{sig(v.amountOutAtFull, tokenOut)}</td>
                          <td className={`num mono ${delta < 0 ? 'dn' : 'mut'}`}>
                            {delta === 0 ? 'best' : bps(delta)}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </Card>

          <LiveTape inSym={inSym} outSym={outSym} amount={amount} tokenOut={tokenOut} />
        </div>
      )}

      <AccountPanel />

      <p className="c-foot-note">
        Unaudited. Trades execute through Uniswap&rsquo;s and Aerodrome&rsquo;s own audited
        routers — this app never holds your funds.
      </p>
    </>
  );
}
