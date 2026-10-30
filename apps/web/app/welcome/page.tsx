import type { Metadata } from 'next';
import { WelcomeForm } from '@/components/welcome-form';

export const metadata: Metadata = { title: 'Welcome' };

export default function WelcomePage() {
  return (
    <main id="main" className="mx-auto max-w-xl px-4 py-10">
      <h1 className="mb-1 text-2xl font-semibold">Welcome to Montra</h1>
      <p className="mb-6 text-sm text-muted">
        Set up your workspace. Personal, business and rental books stay separate for taxes and are shown
        together for the full picture.
      </p>
      <WelcomeForm />
    </main>
  );
}
