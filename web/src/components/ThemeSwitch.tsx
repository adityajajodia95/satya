// "Light · Dark · System" segmented text control (§10.4) — a radio group, keyboard accessible.
import { type ThemeChoice, useTheme } from "../lib/theme";
import s from "./ThemeSwitch.module.css";

const OPTIONS: { value: ThemeChoice; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

export function ThemeSwitch() {
  const [choice, setChoice] = useTheme();
  return (
    <div className={s.switch} role="radiogroup" aria-label="Theme">
      {OPTIONS.map((o, i) => (
        <span key={o.value} className={s.item}>
          {i > 0 && (
            <span className={s.sep} aria-hidden="true">
              ·
            </span>
          )}
          <button
            type="button"
            role="radio"
            aria-checked={choice === o.value}
            className={choice === o.value ? s.active : s.option}
            onClick={() => setChoice(o.value)}
            onKeyDown={(e) => {
              if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
              e.preventDefault();
              const next = OPTIONS[(i + (e.key === "ArrowRight" ? 1 : OPTIONS.length - 1)) % OPTIONS.length]!;
              setChoice(next.value);
              (
                e.currentTarget.parentElement?.parentElement?.querySelectorAll("button")[
                  OPTIONS.indexOf(next)
                ] as HTMLButtonElement | undefined
              )?.focus();
            }}
            tabIndex={choice === o.value ? 0 : -1}
          >
            {o.label}
          </button>
        </span>
      ))}
    </div>
  );
}
