import Link from "next/link";
import { Brand } from "@/components/brand";
import { currentUser } from "@/lib/supabase/server";

export default async function Landing() {
  const user = await currentUser();
  return (
    <main className="min-h-screen">
      <header className="mx-auto max-w-5xl flex items-center justify-between px-6 py-5">
        <Brand />
        <nav className="flex items-center gap-3 text-sm">
          <a href="https://github.com/mkebiclioglu/formlabs-local-mcp" className="text-muted hover:text-ink">GitHub</a>
          {user ? <Link href="/app" className="btn-primary">Open dashboard</Link> : (
            <>
              <Link href="/login" className="btn-ghost">Sign in</Link>
              <Link href="/signup" className="btn-primary">Get a demo farm</Link>
            </>
          )}
        </nav>
      </header>
      <section className="mx-auto max-w-5xl px-6 pt-16 pb-12">
        <p className="text-accent text-sm font-medium mb-3">Hosted MCP · approvals · audit trail</p>
        <h1 className="text-4xl md:text-5xl font-semibold tracking-tight max-w-3xl">The access layer between AI agents and your Formlabs printers.</h1>
        <p className="mt-5 max-w-2xl text-lg text-muted">Give Claude, Codex or any MCP client one URL and one token. Formbridge prepares and prints through PreForm, gates sensitive actions like sending a job to a printer behind human approval, and logs every call.</p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link href="/signup" className="btn-primary text-base px-5 py-2.5">Start with a simulated print farm</Link>
          <Link href="/login" className="btn-ghost text-base px-5 py-2.5">Sign in</Link>
        </div>
      </section>
      <section className="mx-auto max-w-5xl px-6 pb-20 grid gap-4 md:grid-cols-3">
        {[
          ["Same tools, real or simulated", "New accounts get a virtual farm of Form 4, Form 4L, Form 3+ and Fuse 1+ printers with materials, queues, progress, resin use and realistic failures. Connect a real PreForm machine later with one command; the agent's tools do not change."],
          ["Approval gates", "print_to_printer and other sensitive calls wait for a human decision in the dashboard. Deny a tool outright, allow it, or require approval, per environment."],
          ["Complete audit trail", "Every MCP call, approval, token and connector event is recorded, so you know what an agent did to your printers and when."],
        ].map(([t, d]) => (
          <div key={t} className="card p-5">
            <h3 className="font-semibold">{t}</h3>
            <p className="mt-2 text-sm text-muted">{d}</p>
          </div>
        ))}
      </section>
      <footer className="mx-auto max-w-5xl px-6 pb-10 text-xs text-muted">
        Formbridge is an independent project built on <a className="underline" href="https://github.com/mkebiclioglu/formlabs-local-mcp">formlabs-local-mcp</a>. Not affiliated with or endorsed by Formlabs Inc.
      </footer>
    </main>
  );
}
