"use client";

import { useEffect, useState } from "react";
import { AdminNav } from "@/components/admin/AdminNav";
import "../admin.css";

export default function AdminTemplatesPage() {
  const [token, setToken] = useState("");
  const [templates, setTemplates] = useState<unknown[]>([]);
  const [form, setForm] = useState({
    logical_name: "reminder",
    provider_template_name: "",
    language: "pt_BR",
    status: "active",
  });
  const [msg, setMsg] = useState("");

  async function load(tok: string) {
    const res = await fetch("/api/admin/templates", {
      headers: { Authorization: `Bearer ${tok}` },
    });
    const data = await res.json();
    setTemplates(data.templates || []);
  }

  useEffect(() => {
    const t = localStorage.getItem("assessor_admin_token") || "";
    setToken(t);
    if (t) void load(t);
  }, []);

  async function save() {
    const res = await fetch("/api/admin/templates", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(form),
    });
    setMsg(res.ok ? "Template salvo" : "Falha");
    await load(token);
  }

  return (
    <div className="admin-shell admin-shell-nav">
      <header className="admin-top">
        <div>
          <h1 className="admin-brand">Templates</h1>
          <p className="admin-sub">
            Nomes lógicos: verification, reminder, notification
          </p>
        </div>
        <AdminNav current="templates" />
      </header>
      {msg && <p className="toast">{msg}</p>}
      <section className="admin-card">
        <div className="field">
          <label>logical_name</label>
          <input
            value={form.logical_name}
            onChange={(e) => setForm({ ...form, logical_name: e.target.value })}
          />
        </div>
        <div className="field">
          <label>provider_template_name</label>
          <input
            value={form.provider_template_name}
            onChange={(e) =>
              setForm({ ...form, provider_template_name: e.target.value })
            }
          />
        </div>
        <div className="field">
          <label>language</label>
          <input
            value={form.language}
            onChange={(e) => setForm({ ...form, language: e.target.value })}
          />
        </div>
        <div className="field">
          <label>status</label>
          <select
            value={form.status}
            onChange={(e) => setForm({ ...form, status: e.target.value })}
          >
            <option value="draft">draft</option>
            <option value="active">active</option>
          </select>
        </div>
        <button className="btn" type="button" onClick={() => void save()}>
          Salvar
        </button>
        <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, marginTop: 16 }}>
          {JSON.stringify(templates, null, 2)}
        </pre>
      </section>
    </div>
  );
}
