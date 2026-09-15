"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition, type ReactNode } from "react";

/** Re-render server components on an interval so simulated printers move. */
export function AutoRefresh({ seconds = 5 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, seconds * 1000);
    return () => clearInterval(id);
  }, [router, seconds]);
  return null;
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn-ghost text-xs"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard unavailable */
        }
      }}
    >
      {done ? "Copied" : label}
    </button>
  );
}

export function CodeBlock({ code, children }: { code: string; children?: ReactNode }) {
  return (
    <div className="relative group">
      <pre className="rounded-lg border border-line bg-bg pl-3 pr-20 py-2 text-xs overflow-x-auto whitespace-pre-wrap break-all">{code}</pre>
      <div className="absolute right-2 top-2 opacity-70 group-hover:opacity-100">
        <CopyButton text={code} />
      </div>
      {children}
    </div>
  );
}

/** A form button that shows pending state; wraps a server action form. */
export function ActionButton({ action, children, className = "btn-ghost", confirm }: { action: () => Promise<void>; children: ReactNode; className?: string; confirm?: string }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <button
      type="button"
      className={className}
      disabled={pending}
      onClick={() => {
        if (confirm && !window.confirm(confirm)) return;
        start(async () => {
          await action();
          router.refresh();
        });
      }}
    >
      {pending ? "…" : children}
    </button>
  );
}

/** Creates a token and reveals it exactly once. */
export function TokenCreator({ create, kind, environments, defaultEnv }: { create: (fd: FormData) => Promise<{ token: string; name: string; command?: string }>; kind: "mcp" | "connector"; environments: { id: string; name: string; kind: string }[]; defaultEnv?: string }) {
  const [result, setResult] = useState<{ token: string; name: string; command?: string } | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  if (result) {
    return (
      <div className="rounded-lg border border-accent/40 bg-accent/5 p-4 space-y-3">
        <p className="text-sm">Token <strong>{result.name}</strong> created. Copy it now: it is shown only once and stored hashed.</p>
        <CodeBlock code={result.token} />
        {result.command && (
          <>
            <p className="text-xs text-muted">{kind === "connector" ? "Run this on the machine with PreForm:" : "Add it to Claude Code with:"}</p>
            <CodeBlock code={result.command} />
          </>
        )}
        <button type="button" className="btn-ghost" onClick={() => { setResult(null); router.refresh(); }}>Done</button>
      </div>
    );
  }
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        start(async () => setResult(await create(fd)));
      }}
    >
      <div>
        <label className="label">Name</label>
        <input name="name" className="input" placeholder={kind === "mcp" ? "Claude Code on my laptop" : "Studio Mac"} required />
      </div>
      {kind === "mcp" && (
        <div>
          <label className="label">Environment</label>
          <select name="environment_id" className="input" defaultValue={defaultEnv}>
            {environments.map((e) => (
              <option key={e.id} value={e.id}>{e.name} ({e.kind})</option>
            ))}
          </select>
        </div>
      )}
      {kind === "connector" && <input type="hidden" name="environment_id" value={defaultEnv} />}
      <button className="btn-primary" disabled={pending}>{pending ? "Creating…" : kind === "mcp" ? "Create MCP token" : "Create connector token"}</button>
    </form>
  );
}
