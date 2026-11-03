"use client";

import { useEffect, useState } from "react";
import { AdminNav } from "@/components/admin/AdminNav";
import "../admin.css";

type PlanRow = {
  id: string;
  code: string;
  name: string;
  status: string;
  limits: Record<string, unknown>;
  features: Record<string, unknown>;
};

export default function AdminPlansPage() {
  const [token, setToken] = useState("");
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [error, setError] = useState("");
  const [code, setCode] = useState("individual");
  const [name, setName] = useState("Individual");
  const [status, setStatus] = useState("active");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const t = localStorage.getItem("assessor_admin_token") || "";
    setToken(t);
    if (!t) return;
    fetch("/api/admin/plans", { headers: { Authorization: `Bearer ${t}` } })
      .then(async (r) => {
        if (!r.ok) throw new Error("forbidden");
        return r.json();
      })
      .then((d) => setPlans(d.plans || []))
      .catch(() => setError("Sem permissão"));
  }, []);

  async function save() {
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/admin/plans", {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          code,
          name,
          status,
          limits: { messages: 1000 },
          features: { whatsapp: true },
        }),
      });
      if (!res.ok) throw new Error("save_failed");
      const list = await fetch("/api/admin/plans", {
        headers: { Authorization: `Bearer ${token}` },
      }).then((r) => r.json());
      setPlans(list.plans || []);
    } catch {
      setError("Falha ao salvar plano");
    } finally {
      setSaving(false);
    }
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
          <h1 className="admin-brand">Planos</h1>
          <p className="admin-sub">Catálogo interno MOOPE (sem preços)</p>
        </div>
        <AdminNav current="plans" />
      </header>
      {error && <p className="toast err">{error}</p>}
      <section className="admin-card">
        <div className="field">
          <label>Código</label>
          <input value={code} onChange={(e) => setCode(e.target.value)} />
        </div>
        <div className="field">
          <label>Nome</label>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label>Status</label>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="active">active</option>
            <option value="inactive">inactive</option>
            <option value="draft">draft</option>
          </select>
        </div>
        <button className="btn" type="button" disabled={saving} onClick={() => void save()}>
          {saving ? "Salvando…" : "Salvar plano"}
        </button>
      </section>
      <section className="admin-card">
        <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, margin: 0 }}>
          {JSON.stringify(plans, null, 2)}
        </pre>
      </section>
    </div>
  );
}
