'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAccount, useConnect, useDisconnect, useChainId, useSwitchChain } from 'wagmi';
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

export function Masthead() {
  const pathname = usePathname();
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();

  const injected = connectors[0];
  const wrongChain = isConnected && chainId !== base.id;

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
          {wrongChain ? (
            <button className="c-wallet warn" onClick={() => switchChain({ chainId: base.id })}>
              Switch to Base
            </button>
          ) : isConnected ? (
            <button className="c-wallet" onClick={() => disconnect()} title="Disconnect">
              <span className="mono">{addr(address!)}</span>
            </button>
          ) : (
            <button
              className="c-wallet"
              disabled={isPending || !injected}
              onClick={() => injected && connect({ connector: injected })}
            >
              {isPending ? 'Connecting…' : injected ? 'Connect' : 'No wallet'}
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
