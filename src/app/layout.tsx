import type { Metadata } from 'next';
import { Providers } from './providers';
import { Masthead } from '@/components/Masthead';
import './pathia.css';
import './router.css';

export const metadata: Metadata = {
  title: 'base·router — on-chain route solver for Base',
  description:
    'Quotes every major Base venue directly from pool state and solves the optimal split. No aggregator API, no keys.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark">
      <body>
        <Providers>
          <Masthead />
          <div className="shell">{children}</div>
        </Providers>
      </body>
    </html>
  );
}
