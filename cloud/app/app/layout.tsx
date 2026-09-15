import Link from "next/link";
import { redirect } from "next/navigation";
import { signOut } from "@/app/auth-actions";
import { Brand } from "@/components/brand";
import { ensureDemoEnvironment } from "@/lib/onboarding";
import { createUserClient } from "@/lib/supabase/server";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const db = await createUserClient();
  const { data } = await db.auth.getUser();
  if (!data.user) redirect("/login");
  await ensureDemoEnvironment(db, data.user.id);
  const [{ data: envs }, { count: pending }] = await Promise.all([
    db.from("environments").select("id, name, kind").order("created_at"),
    db.from("approvals").select("id", { count: "exact", head: true }).eq("status", "pending"),
  ]);
  const nav: [string, string][] = [
    ["/app", "Overview"],
    ["/app/approvals", `Approvals${pending ? ` (${pending})` : ""}`],
    ["/app/activity", "MCP activity"],
    ["/app/audit", "Audit log"],
    ["/app/tokens", "API tokens"],
    ["/app/connect", "Connect a client"],
  ];
  return (
    <div className="min-h-screen md:grid md:grid-cols-[230px_1fr]">
      <aside className="border-b md:border-b-0 md:border-r border-line bg-panel/60 px-4 py-4 flex flex-col gap-4">
        <Brand compact />
        <nav className="flex md:flex-col gap-1 text-sm overflow-x-auto">
          {nav.map(([href, label]) => (
            <Link key={href} href={href} className="rounded-md px-2 py-1.5 text-muted hover:text-ink hover:bg-panel-2 whitespace-nowrap">{label}</Link>
          ))}
        </nav>
        <div className="hidden md:block">
          <div className="label mt-2">Environments</div>
          <ul className="space-y-1 text-sm">
            {(envs ?? []).map((e) => (
              <li key={String(e["id"])}>
                <Link href={`/app/environments/${e["id"]}`} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-muted hover:text-ink hover:bg-panel-2">
                  <span className={`h-1.5 w-1.5 rounded-full ${e["kind"] === "simulated" ? "bg-info" : "bg-accent"}`} />
                  <span className="truncate">{String(e["name"])}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
        <div className="mt-auto text-xs text-muted flex items-center justify-between gap-2">
          <span className="truncate">{data.user.email}</span>
          <form action={signOut}><button className="underline">Sign out</button></form>
        </div>
      </aside>
      <main className="px-4 md:px-8 py-6 max-w-6xl w-full">{children}</main>
    </div>
  );
}
