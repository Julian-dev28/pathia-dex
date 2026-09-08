/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // WalletConnect is deliberately absent, so no indexedDB/pino shims are
  // needed. Injected wallets only: no project ID, no third-party relay, no
  // key to leak.
  experimental: { optimizePackageImports: ['viem', 'wagmi'] },
};
export default nextConfig;
