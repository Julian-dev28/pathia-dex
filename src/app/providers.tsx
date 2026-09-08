'use client';

import { WagmiProvider, createConfig, http } from 'wagmi';
import { base } from 'wagmi/chains';
// From @wagmi/core rather than wagmi/connectors: that barrel re-exports every
// connector, including Coinbase's, which drags in @base-org/account and a
// half-installed x402 dependency tree that fails the build. We want one
// connector, so we import the one.
import { injected } from '@wagmi/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { RPC_URLS } from '@/lib/chain';

/**
 * Injected connectors only — MetaMask, Rabby, Coinbase Wallet, Brave.
 *
 * WalletConnect would add phone wallets and costs a free project ID, but it
 * also adds a third-party relay between the user and their signer, and a key
 * this project would then have to hold. For a router whose whole claim is that
 * it depends on nothing but public RPC, that trade is not worth one connector.
 */
export const wagmiConfig = createConfig({
  chains: [base],
  connectors: [injected()],
  transports: { [base.id]: http(RPC_URLS[0]) },
  ssr: true,
});

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig;
  }
}

export function Providers({ children }: { children: React.ReactNode }) {
  // One client per mount, not a module singleton: a shared client leaks one
  // user's cached quotes into the next request under SSR.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { staleTime: 4_000, retry: 1, refetchOnWindowFocus: false } },
      }),
  );

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
