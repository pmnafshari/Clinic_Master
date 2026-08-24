/**
 * The public shell.
 *
 * Deliberately bare: no navigation, no authenticated data, nothing that hints
 * at the staff or portal areas. This is the only unauthenticated surface in
 * the application and it should expose exactly one thing.
 */
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-gray-50 py-16">
      <div className="mx-auto max-w-3xl px-4">
        <h1 className="mb-8 text-center text-2xl font-semibold">SmileFlow Dental</h1>
        {children}
      </div>
    </main>
  );
}
