import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Emits .next/standalone: a self-contained server the Docker runtime stage
  // copies without node_modules or sources.
  output: 'standalone',
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
