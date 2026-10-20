import { ProjectLinks, StatusPill, usePlatformStatus } from "aj-demo-kit";
import { Suspense, lazy } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import s from "./App.module.css";
import { OwnerPanel } from "./components/OwnerPanel";
import { ThemeSwitch } from "./components/ThemeSwitch";
import { About } from "./pages/About";
import { Archive } from "./pages/Archive";
import { Desk } from "./pages/Desk";
import { EmptyState } from "./components/ui";

// The charts library is only needed on Benchmarks: loaded on demand, out of the first-paint bundle.
const Benchmarks = lazy(() => import("./pages/Benchmarks").then((m) => ({ default: m.Benchmarks })));

/** Footer links; the write-up is the in-site "How it's built" page. */
export const LINKS: { code?: string; writeup: string; status: string } = {
  code: "https://github.com/adityajajodia95/satya",
  writeup: "/satya/about",
  status: "/status/",
};

export const AUTHOR = {
  name: "Aditya Jajodia",
  degree: "M.Tech in Data Science and Machine Learning",
  email: "adityajajodia95@gmail.com",
};

export function App() {
  const { status } = usePlatformStatus(60_000);
  return (
    <div className={s.shell}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className={s.top}>
        <div className={s.brand}>
          <NavLink to="/" className={s.wordmark} aria-label="Satya — fact desk, home">
            Satya
          </NavLink>
          <span className={`label ${s.tagline}`} aria-hidden="true">
            fact desk
          </span>
        </div>
        <nav className={s.nav} aria-label="Main">
          <NavLink to="/" end>
            Desk
          </NavLink>
          <NavLink to="/archive">Runs</NavLink>
          <NavLink to="/benchmarks">Benchmarks</NavLink>
          <NavLink to="/about">How it's built</NavLink>
        </nav>
        <div className={s.tools}>
          <StatusPill project="satya" status={status} />
          <ThemeSwitch />
        </div>
      </header>
      <main id="main" className={s.main} tabIndex={-1}>
        <Routes>
          <Route path="/" element={<Desk status={status} />} />
          <Route path="/run/:runId" element={<Desk status={status} />} />
          <Route path="/archive" element={<Archive />} />
          <Route
            path="/benchmarks"
            element={
              <Suspense fallback={<EmptyState>Loading results…</EmptyState>}>
                <Benchmarks />
              </Suspense>
            }
          />
          <Route path="/about" element={<About />} />
          <Route
            path="*"
            element={
              <p className={s.notFound}>
                This page doesn't exist. Go back to the <NavLink to="/">Desk</NavLink>.
              </p>
            }
          />
        </Routes>
      </main>
      <footer className={s.footer}>
        <p className={s.author}>
          Built by <strong>{AUTHOR.name}</strong> · {AUTHOR.degree} ·{" "}
          <a href={`mailto:${AUTHOR.email}`}>{AUTHOR.email}</a>
        </p>
        <ProjectLinks code={LINKS.code} writeup={LINKS.writeup} status={LINKS.status} />
        <OwnerPanel />
      </footer>
    </div>
  );
}
