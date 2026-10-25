import { DjangoStatus } from "@/components/ServiceStatus";
import { ONNX_MODELS } from "@/contracts/styles";
import { isSupabaseConfigured, publicEnv } from "@/lib/env";

export default function Home() {
  const supabaseReady = isSupabaseConfigured();

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-10 px-4 py-12 sm:px-8">
      <header className="flex flex-col gap-3">
        <p className="font-mono text-sm text-muted">SWE-492 · Collaborative AI Whiteboard</p>
        <h1 className="text-4xl font-semibold tracking-tight">StarryNight Board</h1>
        <p className="max-w-prose text-muted">
          A real-time multi-user canvas with in-browser neural style previews and temporally consistent
          video stylization. The canvas arrives in milestone M2; this page checks that the foundations are
          wired up.
        </p>
      </header>

      <section aria-labelledby="services" className="rounded-xl border border-border bg-surface p-6">
        <h2 id="services" className="mb-4 text-lg font-medium">
          Services
        </h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 text-sm">
          <dt className="text-muted">Supabase</dt>
          <dd className={supabaseReady ? "text-ok" : "text-warn"}>
            {supabaseReady ? "Configured" : "Not configured (see web/.env.example)"}
          </dd>
          <dt className="text-muted">Sync server</dt>
          <dd className="font-mono">{publicEnv.partykitHost}</dd>
          <dt className="text-muted">Django API</dt>
          <dd>
            <DjangoStatus />
          </dd>
        </dl>
      </section>

      <section aria-labelledby="styles" className="rounded-xl border border-border bg-surface p-6">
        <h2 id="styles" className="mb-4 text-lg font-medium">
          Style models ({Object.keys(ONNX_MODELS).length})
        </h2>
        <ul className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
          {Object.values(ONNX_MODELS).map((m) => (
            <li key={m.id} className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
              <span>{m.label}</span>
              <span className="font-mono text-xs text-muted">
                {m.fixedSize ? `${m.fixedSize[0]}×${m.fixedSize[1]}` : "dynamic"}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
