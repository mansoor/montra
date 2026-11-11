import type { Metadata } from 'next';
import { WelcomeForm } from '@/components/welcome-form';

export const metadata: Metadata = { title: 'Welcome' };

export default async function WelcomePage({ searchParams }: { searchParams: Promise<{ switch?: string }> }) {
  const { switch: switching } = await searchParams;
  return (
    <main id="main" className="mx-auto max-w-xl px-4 py-10">
      <h1 className="page-title mb-1">Welcome to Montra</h1>
      <p className="mb-6 text-sm text-muted">
        Set up your workspace. Personal, business and rental books stay separate for taxes and are shown
        together for the full picture.
      </p>
      <WelcomeForm switchFirst={switching === '1'} />
    </main>
  );
}
