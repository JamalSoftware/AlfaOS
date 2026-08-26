import type { Metadata } from "next";
import Link from "next/link";
import { requirePageProfile } from "@/lib/guards";
import { CreateUserForm } from "./CreateUserForm";

export const metadata: Metadata = {
  title: "Novo usuário",
};

export default async function NewUserPage() {
  await requirePageProfile(["ADMIN"]);

  return (
    <div>
      <div className="mb-6">
        <Link
          href="/usuarios"
          className="text-sm font-medium text-primary-text hover:text-primary-text-hover"
        >
          ← Voltar para usuários
        </Link>
        <h1 className="mt-2 text-2xl font-bold text-fg">
          Novo usuário
        </h1>
        <p className="mt-1 text-sm text-fg-muted">
          Crie um usuário na sua empresa.
        </p>
      </div>

      <div className="max-w-lg rounded-2xl border border-border bg-surface p-6 shadow-sm">
        <CreateUserForm />
      </div>
    </div>
  );
}
