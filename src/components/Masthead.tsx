'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useAccount, useConnect, useDisconnect, useChainId, useSwitchChain } from 'wagmi';
import type { Connector } from 'wagmi';
import { base } from 'wagmi/chains';
import { addr } from '@/lib/format';
import { ThemeToggle } from './ThemeToggle';
import { WalletModal } from './WalletModal';

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

/** EIP-1193 rejection. 4001 is the user declining; -32002 is one already open. */
function rpcCode(error: unknown): number | undefined {
  const e = error as { code?: unknown; cause?: unknown };
  if (typeof e?.code === 'number') return e.code;
  if (e?.cause) return rpcCode(e.cause);
  return undefined;
}

/**
 * Wallet failures are routine and each one wants a different reaction.
 *
 * A wallet that rejects without ever prompting reports the same 4001 as a
 * person clicking "cancel" in a window they did see, so the message says what
 * to check rather than asserting which of the two happened.
 */
function connectMessage(error: Error): string {
  const code = rpcCode(error);
  if (code === 4001) {
    return 'Wallet rejected the request (4001). If no window opened, the site may be blocked in the wallet’s connected-sites list.';
  }
  if (code === -32002) return 'A connection request is already open — check the wallet.';

  const first = error.message.split('\n')[0];
  if (/provider|not found|not detected/i.test(first)) return 'That wallet is no longer available.';
  return first.length > 120 ? `${first.slice(0, 120)}…` : first;
}

export function Masthead() {
  const pathname = usePathname();
  const { address, isConnected } = useAccount();
  const { connect, connectors, error, reset } = useConnect();
  const { disconnect } = useDisconnect();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();

  // null until the probe below has run: the server cannot know what is
  // installed, and rendering "No wallet" while still looking tells the visitor
  // something false for as long as it takes to find out.
  const [wallets, setWallets] = useState<readonly Connector[] | null>(null);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<Connector | null>(null);

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

  const pick = (connector: Connector) => {
    setPending(connector);
    // The chain goes out with the connection rather than as a switch request
    // afterwards, so an approval and a network prompt are not two windows the
    // visitor has to answer in the right order.
    connect(
      { connector, chainId: base.id },
      {
        onSuccess: () => {
          setOpen(false);
          setPending(null);
        },
        // The dialog stays open on failure: the error belongs next to the
        // wallet that produced it, and the next thing the visitor wants is
        // another attempt or a different wallet.
        onError: () => setPending(null),
      },
    );
  };

  const openPicker = () => {
    reset();
    setOpen(true);
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
          {wrongChain ? (
            <button className="c-wallet warn" onClick={() => switchChain({ chainId: base.id })}>
              Switch to Base
            </button>
          ) : isConnected ? (
            <button className="c-wallet" onClick={() => disconnect()} title="Disconnect">
              <span className="mono">{addr(address!)}</span>
            </button>
          ) : wallets?.length === 0 ? (
            <button className="c-wallet" disabled title="No wallet extension found in this browser">
              No wallet
            </button>
          ) : (
            <button className="c-wallet" onClick={openPicker} aria-haspopup="dialog">
              {pending ? 'Connecting…' : 'Connect'}
            </button>
          )}
        </div>
      </div>

      {open && wallets && wallets.length > 0 ? (
        <WalletModal
          wallets={wallets}
          pending={pending}
          error={error ? connectMessage(error) : null}
          onPick={pick}
          onClose={() => {
            setOpen(false);
            setPending(null);
          }}
        />
      ) : null}
    </header>
  );
}
