import type { Metadata } from "next";
import "./globals.css";
import { ThemeProvider } from "@/components/ThemeProvider";
import { THEME_SCRIPT } from "@/lib/theme";

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
    /*
      `suppressHydrationWarning` porque o `THEME_SCRIPT` escreve `data-theme` e
      `style.color-scheme` no `<html>` antes de o React hidratar. O React
      compararia o atributo que ele renderizou com o que está no DOM e
      reclamaria de uma divergência que é o comportamento pretendido.

      O escopo é só este elemento: filhos continuam sendo verificados
      normalmente.
    */
    <html lang="pt-BR" suppressHydrationWarning>
      <head>
        {/*
          Precisa ser inline e bloqueante, dentro do `<head>`: o tema tem de
          estar aplicado ANTES do primeiro paint. Um efeito de React só roda
          depois da hidratação, e até lá quem usa tema escuro veria a página
          clara por alguns quadros.

          `dangerouslySetInnerHTML` é o único caminho para script inline em
          React, e aqui ele é seguro por construção: `THEME_SCRIPT` é uma
          constante estática de `@/lib/theme`, sem nenhuma interpolação de
          dado de usuário, requisição ou banco.
        */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-screen bg-background text-fg antialiased">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
