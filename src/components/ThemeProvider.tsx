"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  DARK_MEDIA_QUERY,
  DEFAULT_THEME_PREFERENCE,
  parseThemePreference,
  resolveTheme,
  THEME_ATTRIBUTE,
  THEME_STORAGE_KEY,
  type ResolvedTheme,
  type ThemePreference,
} from "@/lib/theme";

interface ThemeContextValue {
  /** O que o usuário escolheu. Pode ser `system`. */
  preference: ThemePreference;
  /** O que está aplicado. Nunca é `system`. */
  resolved: ResolvedTheme;
  /**
   * `false` até o efeito de montagem ler o `localStorage`.
   *
   * Existe para o controle não afirmar "Sistema" com ar de certeza enquanto
   * ainda não leu a preferência gravada.
   */
  ready: boolean;
  setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function systemPrefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia(DARK_MEDIA_QUERY).matches
  );
}

/**
 * Estado do tema no cliente.
 *
 * O provider NÃO é quem pinta a primeira tela — isso é do `ThemeScript`, que
 * roda antes do paint. Aqui só se mantém o estado do React em sincronia com
 * o que já está no DOM, e se reage a mudanças posteriores.
 *
 * O estado inicial é o padrão nos dois lados, servidor e cliente. Ler o
 * `localStorage` no inicializador do `useState` faria o HTML do servidor e o
 * primeiro render do cliente divergirem — que é exatamente o hydration
 * mismatch que se quer evitar. A leitura fica no efeito.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(
    DEFAULT_THEME_PREFERENCE,
  );
  const [resolved, setResolved] = useState<ResolvedTheme>("light");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let armazenada: string | null = null;
    try {
      armazenada = window.localStorage.getItem(THEME_STORAGE_KEY);
    } catch {
      // Janela privada ou armazenamento bloqueado. Segue com o padrão.
    }
    const inicial = parseThemePreference(armazenada);
    setPreferenceState(inicial);
    setResolved(resolveTheme(inicial, systemPrefersDark()));
    setReady(true);
  }, []);

  /**
   * Enquanto a preferência for `system`, o tema acompanha o aparelho em tempo
   * real — inclusive a troca automática ao anoitecer, sem recarregar a
   * página. Escolha explícita ignora o sistema, então nem assinamos o evento.
   */
  useEffect(() => {
    if (!ready || preference !== "system") return;

    const mq = window.matchMedia(DARK_MEDIA_QUERY);
    const aoMudar = (evento: MediaQueryListEvent) => {
      setResolved(evento.matches ? "dark" : "light");
    };
    mq.addEventListener("change", aoMudar);
    return () => mq.removeEventListener("change", aoMudar);
  }, [preference, ready]);

  /**
   * Aplica o tema resolvido ao `<html>`.
   *
   * Só depois de `ready`: antes disso o atributo escrito pelo `ThemeScript`
   * já está correto, e sobrescrevê-lo com o palpite do primeiro render
   * causaria justamente o flash que o script evitou.
   */
  useEffect(() => {
    if (!ready) return;
    const raiz = document.documentElement;
    raiz.setAttribute(THEME_ATTRIBUTE, resolved);
    raiz.style.colorScheme = resolved;
  }, [ready, resolved]);

  const setPreference = useCallback((nova: ThemePreference) => {
    // Revalida mesmo vindo do próprio controle: o valor termina num atributo
    // do DOM, e a allowlist é a fronteira.
    const segura = parseThemePreference(nova);
    setPreferenceState(segura);
    setResolved(resolveTheme(segura, systemPrefersDark()));
    setReady(true);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, segura);
    } catch {
      // Sem persistência, o tema ainda vale para esta sessão.
    }
  }, []);

  const valor = useMemo(
    () => ({ preference, resolved, ready, setPreference }),
    [preference, resolved, ready, setPreference],
  );

  return (
    <ThemeContext.Provider value={valor}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const contexto = useContext(ThemeContext);
  if (!contexto) {
    throw new Error("useTheme precisa estar dentro de <ThemeProvider>.");
  }
  return contexto;
}
