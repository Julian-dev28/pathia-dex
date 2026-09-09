import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Standalone output exists for the Dockerfile, which copies a self-contained
  // server without node_modules or sources. Vercel builds through its own
  // output API and does not want it, so it is switched off there rather than
  // leaving two build strategies to argue with each other.
  ...(process.env.VERCEL ? {} : { output: 'standalone' }),
  // Without this, Next walks up looking for a lockfile and picks the one in the
  // home directory, tracing the wrong root into the deployment bundle.
  outputFileTracingRoot: dirname(fileURLToPath(import.meta.url)),
  // The backtest dataset is read from disk at request time. Without this it is
  // not traced into the serverless bundle and the page renders empty in
  // production while working perfectly in development.
  outputFileTracingIncludes: { '/backtest': ['./data/**'] },
  // WalletConnect is deliberately absent, so no indexedDB/pino shims are
  // needed. Injected wallets only: no project ID, no third-party relay, no
  // key to leak.
  experimental: { optimizePackageImports: ['viem', 'wagmi'] },
};
export default nextConfig;
