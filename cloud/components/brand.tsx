import Link from "next/link";

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <Link href="/" className="flex items-center gap-2">
      <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-accent text-accent-ink font-bold">F</span>
      <span className="font-semibold tracking-tight">Formbridge</span>
      {!compact && <span className="text-xs text-muted ml-1">MCP for Formlabs workflows</span>}
    </Link>
  );
}
