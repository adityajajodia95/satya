// Owner mode: a quiet footer control to paste the owner token once in your own browser. It is stored only in
// this browser and lifts the per-visitor limit (free budgets still apply). Hidden unless opened via ?owner.
import { useState } from "react";
import { ownerToken, setOwnerToken } from "../lib/api";
import s from "./OwnerPanel.module.css";

export function OwnerPanel() {
  const [open] = useState(() => new URLSearchParams(window.location.search).has("owner"));
  const [active, setActive] = useState(() => Boolean(ownerToken()));
  const [value, setValue] = useState("");
  if (!open && !active) return null;
  if (active) {
    return (
      <p className={s.panel}>
        Owner mode is on in this browser.{" "}
        <button
          type="button"
          className={s.link}
          onClick={() => (setOwnerToken(null), setActive(false), window.location.reload())}
        >
          Turn off
        </button>
      </p>
    );
  }
  return (
    <form
      className={s.panel}
      onSubmit={(e) => {
        e.preventDefault();
        setOwnerToken(value);
        setActive(Boolean(value.trim()));
        window.location.reload();
      }}
    >
      <label htmlFor="owner-token">Owner token</label>
      <input
        id="owner-token"
        type="password"
        autoComplete="off"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <button type="submit">Save in this browser</button>
    </form>
  );
}
