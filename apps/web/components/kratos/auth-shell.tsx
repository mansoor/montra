import type { ReactNode } from 'react';

/** Centered card layout shared by the sign-in, sign-up and self-service pages. */
export function AuthShell({
  title,
  intro,
  children,
}: {
  title: string;
  intro?: string;
  children: ReactNode;
}) {
  return (
    <main id="main" className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4 py-10">
      <h1 className="mb-1 text-2xl font-semibold">{title}</h1>
      {intro && <p className="mb-6 text-sm text-muted">{intro}</p>}
      <div className="card space-y-4">{children}</div>
    </main>
  );
}
