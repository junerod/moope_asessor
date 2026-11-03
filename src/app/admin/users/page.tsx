"use client";

import { useEffect, useState } from "react";
import { AdminNav } from "@/components/admin/AdminNav";
import "../admin.css";

type ClientRow = {
  id: string;
  name: string | null;
  email: string;
  whatsapp_masked: string | null;
  status: string;
  plan: string | null;
  subscription_status: string | null;
  onboarding: string | null;
  created_at: string;
  last_activity_at: string | null;
  workspace_id: string | null;
};

export default function AdminClientsPage() {
  const [token, setToken] = useState("");
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [q, setQ] = useState("");
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    const t = localStorage.getItem("assessor_admin_token") || "";
    setToken(t);
  }, []);

  useEffect(() => {
    if (!token) return;
    const url = q
      ? `/api/admin/users?q=${encodeURIComponent(q)}`
      : "/api/admin/users";
    fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => {
        if (!r.ok) throw new Error("forbidden");
        return r.json();
      })
      .then((d) => setClients(d.clients || d.users || []))
      .catch(() => setError("Sem permissão"));
  }, [token, q]);

  async function openClient(id: string) {
    setSelected(null);
    const res = await fetch(`/api/admin/users/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      setError("Falha ao carregar cliente");
      return;
    }
    setSelected((await res.json()) as Record<string, unknown>);
  }

  if (!token) {
    return (
      <div className="login-wrap">
        <div className="login-card">
          <p>
            <a href="/admin">Faça login no Admin</a>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="admin-shell admin-shell-nav">
      <header className="admin-top">
        <div>
          <h1 className="admin-brand">Clientes</h1>
          <p className="admin-sub">
            Cadastros via WhatsApp — sem conteúdo privado
          </p>
        </div>
        <AdminNav current="users" />
      </header>
      {error && <p className="toast err">{error}</p>}
      <section className="admin-card">
        <div className="field">
          <label>Busca (nome, e-mail, telefone, ID)</label>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Juneval, +55…"
          />
        </div>
        <div className="table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Nome</th>
                <th>WhatsApp</th>
                <th>E-mail</th>
                <th>Status</th>
                <th>Plano</th>
                <th>Assinatura</th>
                <th>Onboarding</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {clients.map((c) => (
                <tr key={c.id}>
                  <td>{c.name || "—"}</td>
                  <td>{c.whatsapp_masked || "—"}</td>
                  <td>{c.email}</td>
                  <td>{c.status}</td>
                  <td>{c.plan || "—"}</td>
                  <td>{c.subscription_status || "—"}</td>
                  <td>{c.onboarding || "—"}</td>
                  <td>
                    <button
                      className="btn ghost"
                      type="button"
                      onClick={() => void openClient(c.id)}
                    >
                      Detalhe
                    </button>
                  </td>
                </tr>
              ))}
              {clients.length === 0 && (
                <tr>
                  <td colSpan={8}>Nenhum cliente ainda</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
      {selected && (
        <section className="admin-card">
          <h2>Detalhe do cliente</h2>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, margin: 0 }}>
            {JSON.stringify(selected, null, 2)}
          </pre>
        </section>
      )}
    </div>
  );
}
