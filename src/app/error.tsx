'use client';

import { useEffect } from 'react';

/**
 * Route-level error boundary.
 *
 * The failure this actually catches is an RPC endpoint going away mid-render.
 * The message is shown verbatim rather than replaced with "something went
 * wrong": a user who can read "HTTP request failed" knows to try again, and a
 * user who cannot is no worse off for seeing it.
 */
export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    console.error('[pathia-dex]', error);
  }, [error]);

  return (
    <div className="page-head" style={{ paddingTop: 40 }}>
      <h1 className="page-title">Something broke</h1>
      <p className="page-sub">
        This page failed to render. Nothing was signed and no transaction was sent.
      </p>
      <div className="err mt-3" style={{ maxWidth: '70ch' }}>
        {error.message.split('\n')[0]}
      </div>
      <button className="btn mt-3" onClick={reset} type="button">
        Try again
      </button>
    </div>
  );
}
