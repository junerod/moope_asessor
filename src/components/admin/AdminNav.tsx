"use client";

import { useState } from "react";

type Props = {
  current:
    | "dashboard"
    | "users"
    | "access"
    | "plans"
    | "jobs"
    | "templates"
    | "broadcast"
    | "reliability";
  onLogout?: () => void;
};

const LINKS: { href: string; id: Props["current"]; label: string; short: string }[] =
  [
    { href: "/admin", id: "dashboard", label: "Home", short: "Home" },
    { href: "/admin/broadcast", id: "broadcast", label: "Post", short: "Post" },
    {
      href: "/admin/whitelist",
      id: "access",
      label: "Acesso",
      short: "Acesso",
    },
    { href: "/admin/users", id: "users", label: "Clientes", short: "Users" },
    {
      href: "/admin/reliability",
      id: "reliability",
      label: "Confiab.",
      short: "Rel",
    },
    { href: "/admin/jobs", id: "jobs", label: "Jobs", short: "Jobs" },
    { href: "/admin/plans", id: "plans", label: "Planos", short: "Planos" },
    {
      href: "/admin/templates",
      id: "templates",
      label: "Templates",
      short: "Tpl",
    },
  ];

export function AdminNav({ current, onLogout }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <nav className="admin-nav admin-nav-top" aria-label="Admin">
        {LINKS.map((l) => (
          <a
            key={l.id}
            href={l.href}
            aria-current={current === l.id ? "page" : undefined}
          >
            {l.label}
          </a>
        ))}
        {onLogout ? (
          <button type="button" onClick={onLogout}>
            Sair
          </button>
        ) : (
          <a href="/admin">Sair</a>
        )}
      </nav>

      {/* Mobile: barra rolável com TODOS os itens + menu */}
      <nav className="admin-nav-bottom" aria-label="Admin mobile">
        <div className="admin-nav-scroll">
          {LINKS.map((l) => (
            <a
              key={l.id}
              href={l.href}
              aria-current={current === l.id ? "page" : undefined}
            >
              <span>{l.short}</span>
            </a>
          ))}
          <button
            type="button"
            className="admin-nav-more"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            Mais
          </button>
        </div>
      </nav>

      {open ? (
        <div className="admin-sheet" role="dialog" aria-label="Menu admin">
          <div className="admin-sheet-panel">
            <header className="admin-sheet-head">
              <strong>Menu</strong>
              <button type="button" onClick={() => setOpen(false)}>
                Fechar
              </button>
            </header>
            <ul className="admin-sheet-list">
              {LINKS.map((l) => (
                <li key={l.id}>
                  <a
                    href={l.href}
                    aria-current={current === l.id ? "page" : undefined}
                    onClick={() => setOpen(false)}
                  >
                    {l.label}
                  </a>
                </li>
              ))}
              <li>
                {onLogout ? (
                  <button type="button" onClick={onLogout}>
                    Sair
                  </button>
                ) : (
                  <a href="/admin">Sair</a>
                )}
              </li>
            </ul>
          </div>
        </div>
      ) : null}
    </>
  );
}
