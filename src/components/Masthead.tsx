'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAccount, useConnect, useDisconnect, useChainId, useSwitchChain, useBlockNumber } from 'wagmi';
import { base } from 'wagmi/chains';
import { addr } from '@/lib/format';
import { ThemeToggle } from './ThemeToggle';

const NAV = [
  { href: '/', label: 'Terminal' },
  { href: '/depth', label: 'Depth' },
  { href: '/venues', label: 'Venues' },
  { href: '/docs', label: 'Docs' },
];

/**
 * Wallet state lives in the masthead rather than in the trade form, because it
 * is a property of the session and not of the trade. The block number beside it
 * is the honest version of a "live" badge: it is the chain height the quotes
 * were read at, so if it stops moving the user can see that themselves.
 */
export function Masthead() {
  const pathname = usePathname();
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();
  const { data: blockNumber } = useBlockNumber({ watch: true });

  const injectedConnector = connectors[0];
  const wrongChain = isConnected && chainId !== base.id;

  return (
    <header className="masthead">
      <div className="masthead-inner">
        <Link href="/" className="brand">
          pathia dex
        </Link>

        <nav className="tabs-main">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={`nav-link${pathname === n.href ? ' on' : ''}`}
            >
              {n.label}
            </Link>
          ))}
        </nav>

        <div className="masthead-right">
          <span className={`pill${blockNumber ? '' : ' offline'}`}>
            {blockNumber ? `Base ${blockNumber.toString()}` : 'connecting'}
          </span>

          <ThemeToggle />

          {wrongChain ? (
            <button className="btn" onClick={() => switchChain({ chainId: base.id })}>
              Switch to Base
            </button>
          ) : isConnected ? (
            <button className="btn" onClick={() => disconnect()} title="Disconnect">
              <span className="wallet-addr">{addr(address!)}</span>
            </button>
          ) : (
            <button
              className="btn"
              disabled={isPending || !injectedConnector}
              onClick={() => injectedConnector && connect({ connector: injectedConnector })}
            >
              {isPending ? 'Connecting…' : injectedConnector ? 'Connect wallet' : 'No wallet found'}
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
