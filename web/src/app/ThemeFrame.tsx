import type { CSSProperties, ReactNode } from "react";

type Theme = "amber" | "cyan" | "violet";
type ThemeStyle = CSSProperties & Record<`--${string}`, string>;

const themes: Record<Theme, ThemeStyle> = {
  amber: {
    "--accent": "#f0b86c",
    "--accent-soft": "rgba(240,184,108,0.14)",
    "--accent-strong": "#ffc77a",
    "--run-active": "#f0b86c",
    "--st-progress": "#f0b86c",
  },
  cyan: {
    "--accent": "#6cd2e1",
    "--accent-soft": "rgba(108,210,225,0.14)",
    "--accent-strong": "#86dfee",
    "--run-active": "#6cd2e1",
    "--st-progress": "#6cd2e1",
  },
  violet: {
    "--accent": "#a78bfa",
    "--accent-soft": "rgba(167,139,250,0.14)",
    "--accent-strong": "#b8a1ff",
    "--run-active": "#a78bfa",
    "--st-progress": "#e8a55a",
  },
};

export function ThemeFrame({ theme = "amber", children }: { theme?: Theme; children: ReactNode }) {
  return <div style={{ ...themes[theme], height: "100%", width: "100%", background: "var(--bg)" }}>{children}</div>;
}
