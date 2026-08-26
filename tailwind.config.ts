import type { Config } from "tailwindcss";

/**
 * Cada cor abaixo aponta para um token de `src/app/globals.css`.
 *
 * `<alpha-value>` é o que permite `bg-primary/10` funcionar — é o motivo de
 * os tokens serem canais RGB em vez de hex.
 */
const token = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

const config: Config = {
  /**
   * O script inline do `<head>` resolve a preferência e escreve
   * `data-theme="light"` ou `data-theme="dark"` — nunca `system`.
   *
   * A troca de tema acontece nas variáveis CSS, então `dark:` quase não é
   * usado. Fica declarado como escape hatch para o que token nenhum expressa
   * (opacidade de sombra, por exemplo), não como o mecanismo principal.
   */
  darkMode: ["selector", '[data-theme="dark"]'],
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: token("background"),
        surface: {
          DEFAULT: token("surface"),
          elevated: token("surface-elevated"),
          subtle: token("surface-subtle"),
          muted: token("surface-muted"),
        },

        border: {
          DEFAULT: token("border"),
          subtle: token("border-subtle"),
          strong: token("border-strong"),
        },

        fg: {
          DEFAULT: token("fg"),
          secondary: token("fg-secondary"),
          muted: token("fg-muted"),
        },

        primary: {
          DEFAULT: token("primary"),
          hover: token("primary-hover"),
          fg: token("primary-fg"),
          text: token("primary-text"),
          "text-hover": token("primary-text-hover"),
        },

        confirm: {
          DEFAULT: token("confirm"),
          hover: token("confirm-hover"),
        },

        focus: {
          DEFAULT: token("focus"),
          soft: token("focus-soft"),
        },

        success: {
          bg: token("success-bg"),
          border: token("success-border"),
          fg: token("success-fg"),
        },
        warning: {
          bg: token("warning-bg"),
          border: token("warning-border"),
          fg: token("warning-fg"),
        },
        danger: {
          bg: token("danger-bg"),
          border: token("danger-border"),
          fg: token("danger-fg"),
        },
        info: {
          bg: token("info-bg"),
          border: token("info-border"),
          fg: token("info-fg"),
        },
        progress: {
          bg: token("progress-bg"),
          border: token("progress-border"),
          fg: token("progress-fg"),
        },
        neutral: {
          bg: token("neutral-bg"),
          border: token("neutral-border"),
          fg: token("neutral-fg"),
        },

        input: {
          bg: token("input-bg"),
          border: token("input-border"),
        },

        overlay: token("overlay"),
      },
    },
  },
  plugins: [],
};
export default config;
