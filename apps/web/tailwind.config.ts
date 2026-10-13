import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Token-backed palette shared by every screen (see globals.css).
        bg: "var(--nb-bg)",
        surface: "var(--nb-surface)",
        "surface-2": "var(--nb-surface-2)",
        ink: "var(--nb-ink)",
        "ink-soft": "var(--nb-ink-soft)",
        line: "var(--nb-border)",
        accent: {
          DEFAULT: "var(--nb-accent)",
          strong: "var(--nb-accent-strong)",
          ink: "var(--nb-accent-ink)",
          soft: "var(--nb-accent-soft)",
        },
        // Status colours are reserved for operational meaning.
        success: "#15803d",
        danger: "#c8261d",
        warning: "#b45309",
      },
      borderRadius: { nb: "var(--nb-radius)" },
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        display: ["var(--font-display)", "Georgia", "serif"],
      },
    },
  },
  plugins: [],
};
export default config;
