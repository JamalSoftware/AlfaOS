import type { Metadata } from "next";
import Link from "next/link";
import { requirePageProfile } from "@/lib/guards";
import { listTechnicianCandidates } from "@/lib/technicians";
import { TechnicianCreateForm } from "@/components/TechnicianCreateForm";

export const metadata: Metadata = {
  title: "Novo técnico",
};

export default async function NewTechnicianPage() {
  // Must match POST /api/technicians, which is ADMIN-only.
  const session = await requirePageProfile(["ADMIN"]);
  const candidates = await listTechnicianCandidates(session.companyId);

  return (
    <div>
      <div className="mb-6">
        <Link
          href="/tecnicos"
          className="text-sm font-medium text-blue-600 hover:text-blue-700"
        >
          ← Voltar para técnicos
        </Link>
        <h1 className="mt-2 text-2xl font-bold text-slate-900">Novo técnico</h1>
        <p className="mt-1 text-sm text-slate-500">
          Vincule um usuário com perfil Técnico da sua empresa.
        </p>
      </div>

      <div className="max-w-lg rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <TechnicianCreateForm candidates={candidates} />
      </div>
    </div>
  );
}
