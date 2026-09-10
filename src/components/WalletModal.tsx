'use client';

import { useEffect, useRef } from 'react';
import type { Connector } from 'wagmi';

/**
 * The wallet picker.
 *
 * RainbowKit and ConnectKit both want a WalletConnect project ID, which is the
 * relay and the held key this project declines on the trade page's own terms.
 * They are also not needed for what this does: EIP-6963 announcements carry the
 * wallet's name and its icon as a data URI, so every extension in the browser
 * can present itself here without a dependency, a network call, or a key.
 */
export function WalletModal({
  wallets,
  pending,
  error,
  onPick,
  onClose,
}: {
  wallets: readonly Connector[];
  pending: Connector | null;
  error: string | null;
  onPick: (connector: Connector) => void;
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);

  // Focus moves into the dialog so the keyboard is not left behind on the page
  // underneath, and Escape closes it from anywhere inside.
  useEffect(() => {
    panel.current?.querySelector('button')?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="c-modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="c-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wallet-modal-title"
        ref={panel}
      >
        <header className="c-modal-head">
          <h2 id="wallet-modal-title">Connect a wallet</h2>
          <button className="c-modal-x" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <ul className="c-wallet-list">
          {wallets.map((c) => (
            <li key={c.uid}>
              <button
                className="c-wallet-opt"
                disabled={pending !== null}
                onClick={() => onPick(c)}
              >
                {c.icon ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={c.icon} alt="" width={26} height={26} />
                ) : (
                  <span className="c-wallet-mark" aria-hidden="true">
                    {c.name.slice(0, 1)}
                  </span>
                )}
                <span className="c-wallet-name">{c.name}</span>
                <span className="c-wallet-state">
                  {pending?.uid === c.uid ? 'Waiting…' : 'Installed'}
                </span>
              </button>
            </li>
          ))}
        </ul>

        {error ? (
          <p className="c-modal-err" role="status">
            {error}
          </p>
        ) : (
          <p className="c-modal-note">
            Approve the connection in the wallet’s own window. Nothing is signed by connecting.
          </p>
        )}
      </div>
    </div>
  );
}
