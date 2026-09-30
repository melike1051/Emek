import '@emek/ui/tokens.css';
import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Sans, Libre_Caslon_Text } from 'next/font/google';
import { connection } from 'next/server';
import type { ReactNode } from 'react';
import { AppProviders } from '@/providers/AppProviders';

// Fontlar build anında indirilip self-host edilir; çalışma zamanında Google'a istek gitmez (CSP font-src 'self').
const serif = Libre_Caslon_Text({
  subsets: ['latin', 'latin-ext'],
  weight: ['400', '700'],
  variable: '--font-serif-loaded',
  display: 'swap',
});
const sans = IBM_Plex_Sans({
  subsets: ['latin', 'latin-ext'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-sans-loaded',
  display: 'swap',
});

export const metadata: Metadata = {
  title: { default: 'Emek Operasyon', template: '%s · Emek Operasyon' },
  description: 'Emek operasyon ve destek ekibi paneli.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: '#faf6f1',
  width: 'device-width',
  initialScale: 1,
};

/**
 * Dinamik render zorunlu: CSP nonce'u (proxy.ts) yalnız istek anında script'lere basılabilir;
 * derleme anında üretilen statik sayfada nonce olmaz ve script'ler engellenirdi (R-105).
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  await connection();
  return (
    <html lang="tr" className={`${serif.variable} ${sans.variable}`}>
      <body>
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
