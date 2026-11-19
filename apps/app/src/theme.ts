// Light and dark themes (ADR-006). The choice lives in this browser only; default: follow the system.

import { createContext, useContext, useEffect, useState } from "react";

export type ThemeChoice = "system" | "light" | "dark";
export type Theme = "light" | "dark";

const KEY = "covo.theme";
const dark = () => window.matchMedia("(prefers-color-scheme: dark)");

export function savedChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {}
  return "system";
}

export const resolve = (c: ThemeChoice): Theme => (c === "system" ? (dark().matches ? "dark" : "light") : c);

/** Sets <html data-theme>, which switches every token in tokens.css. */
export function applyTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
}

export function useThemeState() {
  const [choice, setChoice] = useState<ThemeChoice>(savedChoice);
  const [theme, setTheme] = useState<Theme>(() => resolve(choice));
  useEffect(() => {
    const update = () => {
      const t = resolve(choice);
      setTheme(t);
      applyTheme(t);
    };
    update();
    const mq = dark();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [choice]);
  const choose = (c: ThemeChoice) => {
    try {
      localStorage.setItem(KEY, c);
    } catch {}
    setChoice(c);
  };
  return { choice, theme, choose };
}

export const ThemeContext = createContext<Theme>("light");
export const useTheme = () => useContext(ThemeContext);
