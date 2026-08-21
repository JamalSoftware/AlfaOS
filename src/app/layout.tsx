import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "AlfaOS",
    template: "%s | AlfaOS",
  },
  description:
    "Plataforma de Ordens de Serviço para equipes técnicas. Base da integração com o ERP ReceitaNet.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">
        {children}
      </body>
    </html>
  );
}
