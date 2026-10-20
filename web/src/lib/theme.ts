// Theme (§10.4): Light · Dark · System; System follows the OS live. The initial theme is set by the inline
// script in index.html before first paint.
import { useEffect, useState } from "react";
import { readStore, writeStore } from "./storage";

export type ThemeChoice = "light" | "dark" | "system";
const KEY = "satya.theme";

const media = () =>
  typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

export function resolveTheme(choice: ThemeChoice): "light" | "dark" {
  return choice === "system" ? (media()?.matches ? "dark" : "light") : choice;
}

export function useTheme(): [ThemeChoice, (c: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(() => {
    const stored = readStore(KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  });
  useEffect(() => {
    document.documentElement.dataset.theme = resolveTheme(choice);
    writeStore(KEY, choice);
    if (choice !== "system") return;
    const m = media();
    const onChange = () => (document.documentElement.dataset.theme = resolveTheme("system"));
    m?.addEventListener("change", onChange);
    return () => m?.removeEventListener("change", onChange);
  }, [choice]);
  return [choice, setChoice];
}
