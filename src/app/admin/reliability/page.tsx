"use client";

import { useEffect, useState } from "react";
import { AdminNav } from "@/components/admin/AdminNav";
import "../admin.css";

type Snapshot = {
  scheduled_future: number;
  overdue_stuck: number;
  delivered_24h: number;
  deliver_failed_24h: number;
  phantoms_24h: number;
  healed_24h: number;
  open_gaps_48h: number;
};

export default function AdminReliabilityPage() {
  const [token, setToken] = useState("");
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [heartbeats, setHeartbeats] = useState<Record<string, { status: string }>>(
    {}
  );
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setToken(localStorage.getItem("assessor_admin_token") || "");
  }, []);

  async function load(t = token) {
    if (!t) return;
    const r = await fetch("/api/admin/reliability", {
      headers: { Authorization: `Bearer ${t}` },
    });
    const d = await r.json();
    if (!r.ok) {
      setError(d.error || "Sem acesso");
      return;
    }
    setSnap(d.snapshot);
    setHeartbeats(d.heartbeats || {});
    setError("");
  }

  useEffect(() => {
    if (token) void load(token);
  }, [token]);

  async function post(action: string) {
    setBusy(true);
    setMsg("");
    setError("");
    try {
      const r = await fetch("/api/admin/reliability", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action }),
      });
      const d = await r.json();
      if (!r.ok) {
        setError(d.error || "Falha");
        return;
      }
      setMsg(JSON.stringify(d.result || d, null, 2));
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <main className="admin-shell">
        <p>
          <a href="/admin">Faça login no Admin</a>
        </p>
      </main>
    );
  }

  return (
    <main className="admin-shell admin-shell-nav">
      <header className="admin-top">
        <div>
          <p className="eyebrow">MOOPE Assessor</p>
          <h1 className="admin-brand">Confiabilidade</h1>
          <p className="admin-sub">
            Gaps, phantoms, overdue e saúde do pipeline de lembretes.
          </p>
        </div>
        <AdminNav current="reliability" />
      </header>

      {error ? <p className="toast err">{error}</p> : null}
      {msg ? (
        <pre className="admin-card" style={{ overflow: "auto" }}>
          {msg}
        </pre>
      ) : null}

      <section className="admin-card">
        <h2>Métricas</h2>
        {snap ? (
          <div className="rel-metrics">
            {(
              [
                ["scheduled_future", "Agendados"],
                ["overdue_stuck", "Overdue stuck"],
                ["delivered_24h", "Entregues 24h"],
                ["deliver_failed_24h", "Falhas entrega 24h"],
                ["phantoms_24h", "Phantoms 24h"],
                ["healed_24h", "Curados 24h"],
                ["open_gaps_48h", "Gaps 48h"],
              ] as const
            ).map(([k, label]) => (
              <div key={k} className="rel-metric">
                <strong>{snap[k]}</strong>
                <span>{label}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted">Carregando…</p>
        )}
      </section>

      <section className="admin-card">
        <h2>Heartbeats</h2>
        <ul>
          {Object.entries(heartbeats).map(([name, hb]) => (
            <li key={name}>
              <strong>{name}</strong>: {hb?.status || "—"}
            </li>
          ))}
        </ul>
        <div className="admin-actions" style={{ marginTop: "1rem" }}>
          <button type="button" disabled={busy} onClick={() => void load()}>
            Atualizar
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => void post("heal")}
          >
            Rodar cura agora
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => void post("alert_check")}
          >
            Checar alertas
          </button>
        </div>
      </section>

      <section className="admin-card">
        <h2>WhatsApp DEV (só o seu número)</h2>
        <p className="muted">
          No Zap do DEV (+55 61 99671-5985), mande:
        </p>
        <ul>
          <li>
            <code>/saude</code> — visão geral (pipeline + uso + infra)
          </li>
          <li>
            <code>/status</code> — ready rápido
          </li>
          <li>
            <code>/uso</code> — KPIs de clientes / lembretes / tools
          </li>
          <li>
            <code>/servidor</code> — RAM, CPU, disco, Postgres, fila
          </li>
          <li>
            <code>/cura</code> — heal gaps (7 dias)
          </li>
          <li>
            <code>/alerta</code> — força checagem de limiares
          </li>
          <li>
            <code>/ops</code> — lista os comandos
          </li>
        </ul>
        <p className="muted">
          Alertas de limite (RAM / disco / PG / fila) chegam sozinhos no Zap DEV.
          Outros números não veem esses comandos.
        </p>
      </section>
    </main>
  );
}
