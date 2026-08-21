import { requirePageSession } from "@/lib/guards";
import { prisma } from "@/lib/prisma";
import { Sidebar } from "@/components/Sidebar";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requirePageSession();

  const company = await prisma.company.findUnique({
    where: { id: session.companyId },
  });

  return (
    <div className="flex min-h-screen">
      <Sidebar
        profile={session.profile}
        userName={session.name}
        companyName={company?.name ?? "Empresa"}
      />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-6 py-8">{children}</div>
      </main>
    </div>
  );
}
