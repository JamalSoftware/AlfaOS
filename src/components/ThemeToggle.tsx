"use client";

import { useId } from "react";
import { useTheme } from "./ThemeProvider";
import {
  THEME_LABELS,
  THEME_PREFERENCES,
  parseThemePreference,
} from "@/lib/theme";

/**
 * Seletor de tema.
 *
 * `<select>` nativo em vez de um menu próprio: já vem com navegação por
 * teclado, leitura por leitor de tela e o seletor do sistema operacional no
 * celular — coisas que uma reimplementação erraria em silêncio.
 *
 * Fica no rodapé da Sidebar porque é o único lugar que atende os dois lados
 * do pedido: aparece no desktop e na gaveta do celular, alcança TODOS os
 * perfis (a página de configurações é só de ADMIN) e não ocupa área
 * operacional da OS.
 */
export function ThemeToggle() {
  const { preference, ready, setPreference } = useTheme();
  const id = useId();

  return (
    <div className="mt-3 flex items-center gap-2">
      <label
        htmlFor={id}
        className="shrink-0 text-xs font-medium text-fg-muted"
      >
        Tema
      </label>
      <select
        id={id}
        data-testid="theme-select"
        value={preference}
        // Enquanto a preferência gravada não foi lida, o controle mostra o
        // padrão. Anunciar isso evita que um leitor de tela leia um valor que
        // muda sozinho um instante depois.
        aria-busy={!ready}
        onChange={(evento) =>
          setPreference(parseThemePreference(evento.target.value))
        }
        className="min-w-0 flex-1 rounded-md border border-input-border bg-input-bg px-2 py-1 text-xs font-medium text-fg-secondary outline-none transition-colors focus:border-focus focus:ring-2 focus:ring-focus-soft"
      >
        {THEME_PREFERENCES.map((opcao) => (
          <option key={opcao} value={opcao}>
            {THEME_LABELS[opcao]}
          </option>
        ))}
      </select>
    </div>
  );
}
