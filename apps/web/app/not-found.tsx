import Link from 'next/link';

export default function NotFound() {
  return (
    <main id="main" className="mx-auto max-w-md px-4 py-16 text-center">
      <h1 className="text-2xl font-semibold">Not found</h1>
      <p className="mt-2 text-sm text-muted">This page doesn’t exist or you don’t have access to it.</p>
      <Link href="/" className="btn-primary mt-6">
        Go home
      </Link>
    </main>
  );
}
