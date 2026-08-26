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
    <div className="flex min-h-screen flex-col bg-background md:flex-row">
      <Sidebar
        profile={session.profile}
        userName={session.name}
        companyName={company?.name ?? "Empresa"}
      />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-4 py-6 md:px-6 md:py-8">
          {children}
        </div>
      </main>
    </div>
  );
}
