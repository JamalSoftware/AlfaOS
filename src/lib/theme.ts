/**
 * Tema do AlfaOS — preferência, resolução e persistência.
 *
 * Este arquivo é lógica pura de propósito: ele não toca React nem o DOM, e é
 * por isso que dá para testá-lo sem navegador. Quem aplica o resultado é o
 * `ThemeScript` (antes do primeiro paint) e o `ThemeProvider` (depois).
 */

/**
 * Preferência do usuário. Três valores, e nenhum outro.
 *
 * `system` não é um tema — é a ausência de escolha, delegando ao aparelho.
 * Ele nunca chega ao atributo `data-theme`: o que vai para o DOM é sempre o
 * tema RESOLVIDO, `light` ou `dark`.
 */
export const THEME_PREFERENCES = ["light", "dark", "system"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

/** Tema efetivamente aplicado. `system` já foi resolvido aqui. */
export type ResolvedTheme = "light" | "dark";

export const DEFAULT_THEME_PREFERENCE: ThemePreference = "system";

/**
 * Chave do `localStorage`.
 *
 * Prefixada porque o `localStorage` é compartilhado por origem: sem prefixo,
 * qualquer outra coisa servida do mesmo host disputaria o nome.
 */
export const THEME_STORAGE_KEY = "alfaos-theme";

/** Atributo que carrega o tema resolvido. É nele que o CSS engata. */
export const THEME_ATTRIBUTE = "data-theme";

export const THEME_LABELS: Record<ThemePreference, string> = {
  light: "Claro",
  dark: "Escuro",
  system: "Sistema",
};

/**
 * Allowlist fechada.
 *
 * O valor vem do `localStorage`, que é gravável por qualquer script rodando
 * na origem e editável à mão pelo usuário. Ele termina num atributo do
 * `<html>`, então tratar a string como confiável deixaria entrar valor
 * arbitrário no DOM. Qualquer coisa fora dos três valores conhecidos vira o
 * padrão, em silêncio — não existe estado de erro a mostrar aqui.
 */
export function parseThemePreference(value: unknown): ThemePreference {
  return THEME_PREFERENCES.includes(value as ThemePreference)
    ? (value as ThemePreference)
    : DEFAULT_THEME_PREFERENCE;
}

/**
 * Resolve a preferência para o tema que será aplicado.
 *
 * `systemPrefersDark` é o que o aparelho respondeu a
 * `prefers-color-scheme: dark`. A escolha explícita do usuário vence o
 * sistema — é o ponto inteiro de existir uma escolha.
 */
export function resolveTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (preference === "light") return "light";
  if (preference === "dark") return "dark";
  return systemPrefersDark ? "dark" : "light";
}

/** Media query única, para o script e o provider não divergirem. */
export const DARK_MEDIA_QUERY = "(prefers-color-scheme: dark)";

/**
 * Script que roda ANTES do primeiro paint.
 *
 * Precisa ser inline e bloqueante: se o tema fosse aplicado depois da
 * hidratação, o usuário de tema escuro veria a página clara por alguns
 * quadros — o flash branco às três da manhã que o tema escuro existe para
 * evitar.
 *
 * É uma string estática escrita aqui, sem nenhuma interpolação de dado de
 * usuário. O valor lido do `localStorage` é validado contra a mesma
 * allowlist de `parseThemePreference` antes de chegar ao DOM, e o `catch`
 * vazio é deliberado: `localStorage` lança em janela privada e com cookies
 * de terceiro bloqueados. Falhando, o atributo não é escrito, e o
 * `@media (prefers-color-scheme)` do CSS assume — que é exatamente o
 * comportamento padrão desejado.
 */
export const THEME_SCRIPT = `(function(){try{
var p=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
if(${JSON.stringify([...THEME_PREFERENCES])}.indexOf(p)===-1){p=${JSON.stringify(DEFAULT_THEME_PREFERENCE)};}
var r=p==="system"?(window.matchMedia(${JSON.stringify(DARK_MEDIA_QUERY)}).matches?"dark":"light"):p;
var e=document.documentElement;
e.setAttribute(${JSON.stringify(THEME_ATTRIBUTE)},r);
e.style.colorScheme=r;
}catch(_){}})();`;
