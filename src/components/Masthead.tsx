'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useAccount, useConnect, useDisconnect, useChainId, useSwitchChain } from 'wagmi';
import type { Connector } from 'wagmi';
import { base } from 'wagmi/chains';
import { addr } from '@/lib/format';
import { ThemeToggle } from './ThemeToggle';

/**
 * Trade first, everything else after.
 *
 * The nav used to list five peers in the order they were built. Someone landing
 * here wants to trade; the research pages are where they go afterwards, and the
 * order now says so. The live block pill is gone from the bar entirely — a
 * number changing every two seconds in the corner of the eye is the definition
 * of a distraction, and the quote states its own block where that matters.
 */
const NAV = [
  { href: '/', label: 'Trade' },
  { href: '/tools', label: 'Tools' },
  { href: '/depth', label: 'Depth' },
  { href: '/venues', label: 'Venues' },
  { href: '/backtest', label: 'Backtest' },
  { href: '/docs', label: 'Method' },
];

/** Wallet failures are routine and each one wants a different reaction. */
function connectMessage(error: Error): string {
  const first = error.message.split('\n')[0];
  if (/rejected|denied/i.test(first)) return 'Rejected in wallet';
  if (/provider|not found|not detected/i.test(first)) return 'Wallet unavailable';
  if (/pending|already processing/i.test(first)) return 'Check your wallet';
  return first.length > 56 ? `${first.slice(0, 56)}…` : first;
}

export function Masthead() {
  const pathname = usePathname();
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending, error, reset } = useConnect();
  const { disconnect } = useDisconnect();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();

  const [wallets, setWallets] = useState<readonly Connector[]>([]);
  const [picking, setPicking] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  /**
   * Which wallets are actually here.
   *
   * A connector exists whether or not its wallet does: `injected()` is built
   * from config and only looks for `window.ethereum` when you click it. So the
   * button cannot ask the connector list whether a wallet is installed — it has
   * to ask each connector for its provider, or it ends up offering to connect
   * to nothing and failing on click.
   */
  useEffect(() => {
    let live = true;

    (async () => {
      const probed = await Promise.all(
        connectors.map(async (c) => ((await c.getProvider().catch(() => null)) ? c : null)),
      );
      if (!live) return;

      const usable = probed.filter((c): c is Connector => c !== null);
      // Wallets that announced themselves carry an rdns; the generic connector
      // does not. Prefer the announced ones — they address a specific extension,
      // where window.ethereum addresses whichever one loaded last, which is how
      // clicking "OKX" opens MetaMask.
      const announced = usable.filter((c) => c.rdns);
      setWallets(announced.length > 0 ? announced : usable);
    })();

    return () => {
      live = false;
    };
  }, [connectors]);

  const wrongChain = isConnected && chainId !== base.id;

  const start = (connector: Connector) => {
    reset();
    setPicking(false);
    connect({ connector });
  };

  return (
    <header className="c-bar">
      <div className="c-bar-in">
        <Link href="/" className="c-brand">
          PATHIA
        </Link>

        <nav className="c-nav" aria-label="Sections">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={`c-nav-link${pathname === n.href ? ' on' : ''}`}
              aria-current={pathname === n.href ? 'page' : undefined}
            >
              {n.label}
            </Link>
          ))}
        </nav>

        <div className="c-bar-right">
          <ThemeToggle />
          {error && !isPending && !isConnected ? (
            <span className="c-wallet-err" role="status">
              {connectMessage(error)}
            </span>
          ) : null}
          {wrongChain ? (
            <button className="c-wallet warn" onClick={() => switchChain({ chainId: base.id })}>
              Switch to Base
            </button>
          ) : isConnected ? (
            <button className="c-wallet" onClick={() => disconnect()} title="Disconnect">
              <span className="mono">{addr(address!)}</span>
            </button>
          ) : wallets.length === 0 ? (
            <button className="c-wallet" disabled title="No wallet extension found in this browser">
              No wallet
            </button>
          ) : (
            <div
              className="c-wallet-wrap"
              ref={wrap}
              onBlur={(e) => {
                if (!wrap.current?.contains(e.relatedTarget as Node | null)) setPicking(false);
              }}
              onKeyDown={(e) => e.key === 'Escape' && setPicking(false)}
            >
              <button
                className="c-wallet"
                disabled={isPending}
                aria-haspopup={wallets.length > 1 || undefined}
                aria-expanded={wallets.length > 1 ? picking : undefined}
                onClick={() => (wallets.length === 1 ? start(wallets[0]) : setPicking((p) => !p))}
              >
                {isPending ? 'Connecting…' : 'Connect'}
              </button>

              {picking && wallets.length > 1 ? (
                <ul className="c-wallet-menu">
                  {wallets.map((c) => (
                    <li key={c.uid}>
                      <button onClick={() => start(c)}>{c.name}</button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
