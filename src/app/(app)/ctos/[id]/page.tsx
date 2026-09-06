import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCto, isCtoNetworkEnabled } from "@/lib/cto";
import { requirePageProfile } from "@/lib/guards";
import { CtoDetailManager } from "./CtoDetailManager";

export const metadata: Metadata = {
  title: "CTO",
};

export default async function CtoDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const session = await requirePageProfile(["ADMIN"]);

  if (!(await isCtoNetworkEnabled(session.companyId))) {
    notFound();
  }

  // `getCto` já filtra por `companyId` no predicado. Id de outra empresa cai
  // aqui como inexistente — que é exatamente o que ele deve parecer.
  const cto = await getCto(session.companyId, params.id);
  if (!cto) {
    notFound();
  }

  return (
    <div>
      <div className="mb-6">
        <Link
          href="/ctos"
          className="text-sm text-fg-muted transition-colors hover:text-fg"
        >
          ← CTOs
        </Link>
        <h1 className="mt-2 text-2xl font-bold text-fg">{cto.name}</h1>
        <p className="mt-1 text-sm text-fg-muted">
          {cto.capacity} portas
          {cto.code ? ` · código ${cto.code}` : ""}
          {cto.active ? "" : " · inativa"}
        </p>
      </div>

      <CtoDetailManager cto={cto} />
    </div>
  );
}
