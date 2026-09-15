import Link from "next/link";
import type { ReactNode } from "react";

export function Card({ title, action, children, className = "" }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          {action}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

const tones: Record<string, string> = {
  ok: "bg-ok/15 text-ok",
  warn: "bg-warn/15 text-warn",
  danger: "bg-danger/15 text-danger",
  info: "bg-info/15 text-info",
  muted: "bg-muted/15 text-muted",
  accent: "bg-accent/15 text-accent",
};

export function Badge({ tone = "muted", children }: { tone?: keyof typeof tones; children: ReactNode }) {
  return <span className={`badge ${tones[tone]}`}>{children}</span>;
}

export function statusTone(status: string): keyof typeof tones {
  switch (status.toUpperCase()) {
    case "IDLE": case "FINISHED": case "OK": case "EXECUTED": case "DONE": case "ALLOW": return "ok";
    case "PRINTING": case "PREHEATING": case "COOLING": case "RUNNING": case "QUEUED": case "SUBMITTED": case "APPROVED": return "info";
    case "PAUSED": case "PENDING": case "PENDING_APPROVAL": case "APPROVE": return "warn";
    case "ERROR": case "FAILED": case "DENIED": case "DENY": case "ABORTED": return "danger";
    case "OFFLINE": case "EXPIRED": return "muted";
    default: return "muted";
  }
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted py-6 text-center">{children}</p>;
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="card px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      <div className="text-2xl font-semibold mt-1">{value}</div>
      {hint && <div className="text-xs text-muted mt-1">{hint}</div>}
    </div>
  );
}

export function Tabs({ base, current, tabs }: { base: string; current: string; tabs: { key: string; label: string; count?: number }[] }) {
  return (
    <nav className="flex gap-1 border-b border-line mb-4 overflow-x-auto">
      {tabs.map((t) => (
        <Link key={t.key} href={`${base}?tab=${t.key}`} className={`px-3 py-2 text-sm whitespace-nowrap border-b-2 -mb-px ${current === t.key ? "border-accent text-ink" : "border-transparent text-muted hover:text-ink"}`}>
          {t.label}
          {t.count !== undefined && t.count > 0 && <span className="ml-1.5 rounded-full bg-panel-2 px-1.5 text-xs">{t.count}</span>}
        </Link>
      ))}
    </nav>
  );
}

export function Progress({ value }: { value: number }) {
  return (
    <div className="h-1.5 w-full rounded-full bg-panel-2 overflow-hidden">
      <div className="h-full bg-accent transition-all" style={{ width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%` }} />
    </div>
  );
}
