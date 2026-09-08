import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Without this, Next walks up looking for a lockfile and picks the one in the
  // home directory, tracing the wrong root into the deployment bundle.
  outputFileTracingRoot: dirname(fileURLToPath(import.meta.url)),
  // WalletConnect is deliberately absent, so no indexedDB/pino shims are
  // needed. Injected wallets only: no project ID, no third-party relay, no
  // key to leak.
  experimental: { optimizePackageImports: ['viem', 'wagmi'] },
};
export default nextConfig;
