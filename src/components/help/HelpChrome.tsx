"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  { href: "/", label: "Início", icon: "fa-house", on: (path: string) => path === "/" },
  { href: "/ajuda", label: "Começar", icon: "fa-play", on: (path: string) => path === "/ajuda" },
  {
    href: "/ajuda/pessoal",
    label: "Pessoal",
    icon: "fa-user",
    on: (path: string) => path.startsWith("/ajuda/pessoal"),
  },
  {
    href: "/ajuda/locadora",
    label: "Locadora",
    icon: "fa-truck",
    on: (path: string) => path.startsWith("/ajuda/locadora"),
  },
  {
    href: "/ajuda/facejus",
    label: "Facejus",
    icon: "fa-scale-balanced",
    on: (path: string) => path.startsWith("/ajuda/facejus"),
  },
];

export function HelpChrome({ children }: { children: React.ReactNode }) {
  const path = usePathname() || "/";

  return (
    <div className="help-shell">
      <header className="help-top no-print">
        <Link href="/" className="help-brand">
          <img
            src="/brand/moope-assessor-logo.png"
            alt="MOOPE Assessor"
            width={64}
            height={64}
          />
          <div className="brand-text">
            <strong>MOOPE Assessor</strong>
            <span>no WhatsApp</span>
          </div>
        </Link>
        <nav className="help-actions" aria-label="Manuais">
          {NAV.map((item) => (
            <Link
              key={item.href}
              className={`btn btn-secondary help-nav-btn${item.on(path) ? " is-on" : ""}`}
              href={item.href}
              aria-current={item.on(path) ? "page" : undefined}
            >
              <i className={`fa-solid ${item.icon}`} aria-hidden />
              <span className="nav-label">{item.label}</span>
            </Link>
          ))}
        </nav>
      </header>
      {children}
      <footer className="help-footer">
        <img src="/brand/moope-assessor-logo.png" alt="" width={48} height={48} />
        <div>
          <strong>MOOPE Assessor</strong> ·{" "}
          <a href="https://moope.com.br" target="_blank" rel="noreferrer">
            moope.com.br
          </a>
        </div>
      </footer>
    </div>
  );
}
