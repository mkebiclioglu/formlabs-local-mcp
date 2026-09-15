import Link from "next/link";
import { signIn } from "@/app/auth-actions";
import { AuthForm } from "@/components/auth-form";
import { Brand } from "@/components/brand";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-6">
        <Brand />
        <div className="card p-6">
          <h1 className="text-lg font-semibold mb-4">Sign in</h1>
          <AuthForm action={signIn} submit="Sign in" next={next} />
        </div>
        <p className="text-sm text-muted text-center">New here? <Link href="/signup" className="text-accent">Create an account</Link>, you get a demo print farm instantly.</p>
      </div>
    </main>
  );
}
