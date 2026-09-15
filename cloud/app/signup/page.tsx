import Link from "next/link";
import { signUp } from "@/app/auth-actions";
import { AuthForm } from "@/components/auth-form";
import { Brand } from "@/components/brand";

export default function SignupPage() {
  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-6">
        <Brand />
        <div className="card p-6">
          <h1 className="text-lg font-semibold mb-1">Create your account</h1>
          <p className="text-sm text-muted mb-4">You get a simulated Formlabs print farm right away, no printer needed.</p>
          <AuthForm action={signUp} submit="Sign up" />
        </div>
        <p className="text-sm text-muted text-center">Already registered? <Link href="/login" className="text-accent">Sign in</Link></p>
      </div>
    </main>
  );
}
