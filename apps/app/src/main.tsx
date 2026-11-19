import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { applyTheme, resolve, savedChoice } from "./theme.ts";

// Set the theme before the first paint, so the page never flashes the wrong one.
applyTheme(resolve(savedChoice()));

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
