import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { LoginForm } from "./LoginForm";
import { defaultPageFor } from "@/lib/guards";
import { getSessionUser } from "@/lib/session";

export const metadata: Metadata = {
  title: "Entrar",
};

export default async function LoginPage() {
  const session = await getSessionUser();
  if (session) {
    redirect(defaultPageFor(session.profile));
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-subtle px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary text-2xl font-bold text-primary-fg">
            A
          </div>
          <h1 className="text-2xl font-bold text-fg">AlfaOS</h1>
          <p className="mt-1 text-sm text-fg-muted">
            Plataforma de Ordens de Serviço
          </p>
        </div>
        <div className="rounded-2xl border border-border bg-surface p-6 shadow-sm">
          <LoginForm />
        </div>
        <p className="mt-6 text-center text-xs text-fg-muted">
          © {new Date().getFullYear()} AlfaOS. Base para integração com o ERP
          ReceitaNet.
        </p>
      </div>
    </div>
  );
}
