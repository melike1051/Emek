import '@emek/ui/tokens.css';
import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Sans, Libre_Caslon_Text } from 'next/font/google';
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

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="tr" className={`${serif.variable} ${sans.variable}`}>
      <body>
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
