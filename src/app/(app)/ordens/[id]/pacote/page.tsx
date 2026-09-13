import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requirePageProfile } from "@/lib/guards";
import { loadServiceOrderEvidencePackage } from "@/lib/service-order-evidence-package";
import { ServiceOrderEvidencePackageView } from "@/components/ServiceOrderEvidencePackageView";

export const metadata: Metadata = {
  title: "Pacote técnico",
};

/**
 * Pacote técnico de evidências da OS — EV-1 (PRD §383).
 *
 * Os mesmos perfis que abrem a OS, e pela mesma regra: empresa da sessão, e o
 * técnico só a própria OS. Quem não pode ver a OS recebe 404, como na tela
 * dela — o pacote não é um atalho para o que a OS não mostraria.
 */
export default async function EvidencePackagePage({
  params,
}: {
  params: { id: string };
}) {
  const session = await requirePageProfile(["ADMIN", "DISPATCHER", "TECHNICIAN"]);

  const section = await loadServiceOrderEvidencePackage(
    { companyId: session.companyId, userId: session.id, profile: session.profile },
    params.id,
  );
  if (section.state === "not-found") {
    notFound();
  }

  return <ServiceOrderEvidencePackageView orderId={params.id} section={section} />;
}
