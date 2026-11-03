import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import '@fontsource-variable/figtree';
import '@fontsource-variable/fraunces';
import './globals.css';
import { THEME_INIT } from '@/lib/theme';
import { ThemeFollower } from '@/components/theme-choice';

export const metadata: Metadata = {
  title: { default: 'Montra', template: '%s · Montra' },
  description: 'Personal, business and rental money in one place.',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // The theme script sets data-theme before React hydrates, so the attribute differs from the server's.
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta name="color-scheme" content="light dark" />
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body className="min-h-screen antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-surface focus:p-2"
        >
          Skip to content
        </a>
        <ThemeFollower />
        {children}
      </body>
    </html>
  );
}
