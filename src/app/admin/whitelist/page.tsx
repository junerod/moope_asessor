"use client";

import { useEffect, useState } from "react";
import { AdminNav } from "@/components/admin/AdminNav";
import "../admin.css";

type Entry = {
  id: string;
  phone_e164: string;
  label?: string | null;
  notes?: string | null;
  reason?: string | null;
  created_at?: string;
};

export default function AdminAccessPage() {
  const [token, setToken] = useState("");
  const [whitelist, setWhitelist] = useState<Entry[]>([]);
  const [blacklist, setBlacklist] = useState<Entry[]>([]);
  const [paywall, setPaywall] = useState(false);
  const [contactPhone, setContactPhone] = useState("");
  const [contactLabel, setContactLabel] = useState("");
  const [phone, setPhone] = useState("");
  const [label, setLabel] = useState("");
  const [notes, setNotes] = useState("");
  const [banPhone, setBanPhone] = useState("");
  const [banReason, setBanReason] = useState("");
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [tab, setTab] = useState<"liberar" | "banir" | "contato">("liberar");

  useEffect(() => {
    setToken(localStorage.getItem("assessor_admin_token") || "");
  }, []);

  async function load(t = token) {
    if (!t) return;
    const r = await fetch("/api/admin/whitelist", {
      headers: { Authorization: `Bearer ${t}` },
    });
    if (!r.ok) {
      setError("Sem acesso — faça login no Admin.");
      return;
    }
    const d = await r.json();
    setWhitelist(d.whitelist || d.entries || []);
    setBlacklist(d.blacklist || []);
    setPaywall(Boolean(d.paywall_enforced));
    setContactPhone(d.moope_contact?.phone_e164 || "");
    setContactLabel(d.moope_contact?.label || "Comercial / suporte MOOPE");
    setError("");
  }

  useEffect(() => {
    if (token) void load(token);
  }, [token]);

  async function post(body: Record<string, unknown>) {
    const r = await fetch("/api/admin/whitelist", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      setError(d.error || "Falha");
      return false;
    }
    return true;
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
          <h1 className="admin-brand">Acesso</h1>
          <p className="admin-sub">
            Liberar, banir e contato comercial — use no celular.
          </p>
        </div>
        <AdminNav current="access" />
      </header>

      {error ? <p className="toast err">{error}</p> : null}
      {msg ? <p className="toast">{msg}</p> : null}

      <div className="access-tabs" role="tablist">
        {(
          [
            ["liberar", "Liberar"],
            ["banir", "Banir"],
            ["contato", "Contato MOOPE"],
          ] as const
        ).map(([id, labelText]) => (
          <button
            key={id}
            type="button"
            role="tab"
            className={tab === id ? "on" : ""}
            aria-selected={tab === id}
            onClick={() => setTab(id)}
          >
            {labelText}
          </button>
        ))}
      </div>

      {tab === "contato" ? (
        <section className="admin-card">
          <h2>Número para liberar o Assessor</h2>
          <p className="hint">
            Quando o trial acaba o limite diário, o Assessor manda: “Quer
            liberar? Fala com a MOOPE” + este WhatsApp. Pode trocar a qualquer
            hora.
          </p>
          <form
            className="stack"
            onSubmit={async (e) => {
              e.preventDefault();
              setMsg("");
              const ok = await post({
                action: "moope_contact",
                contact_phone: contactPhone,
                contact_label: contactLabel,
              });
              if (ok) {
                setMsg("Contato MOOPE salvo.");
                await load();
              }
            }}
          >
            <label className="field">
              <span>WhatsApp (E.164)</span>
              <input
                value={contactPhone}
                onChange={(e) => setContactPhone(e.target.value)}
                placeholder="+5561…"
                required
                inputMode="tel"
              />
            </label>
            <label className="field">
              <span>Rótulo</span>
              <input
                value={contactLabel}
                onChange={(e) => setContactLabel(e.target.value)}
                placeholder="Comercial / suporte MOOPE"
              />
            </label>
            <button type="submit" className="btn btn-block">
              Salvar contato
            </button>
          </form>
        </section>
      ) : null}

      {tab === "liberar" ? (
        <>
          <section className="admin-card">
            <h2>Paywall</h2>
            <p className="hint">
              Agora: <strong>{paywall ? "LIGADO" : "DESLIGADO"}</strong>
            </p>
            <button
              type="button"
              className="btn btn-block"
              onClick={async () => {
                const ok = await post({ paywall_enforced: !paywall });
                if (ok) {
                  setPaywall(!paywall);
                  setMsg(paywall ? "Paywall desligado." : "Paywall ligado.");
                }
              }}
            >
              {paywall ? "Desligar paywall" : "Ligar paywall"}
            </button>
          </section>

          <section className="admin-card">
            <h2>Liberar número</h2>
            <p className="hint">
              Whitelist = acesso garantido, sem teto diário de avaliação.
            </p>
            <form
              className="stack"
              onSubmit={async (e) => {
                e.preventDefault();
                setMsg("");
                const ok = await post({
                  action: "whitelist_add",
                  phone,
                  label: label || undefined,
                  notes: notes || undefined,
                });
                if (ok) {
                  setPhone("");
                  setLabel("");
                  setNotes("");
                  setMsg("Número liberado.");
                  await load();
                }
              }}
            >
              <label className="field">
                <span>WhatsApp</span>
                <input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+5511999999999"
                  required
                  inputMode="tel"
                />
              </label>
              <label className="field">
                <span>Rótulo</span>
                <input
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="VIP / MOOPE / Facejus"
                />
              </label>
              <label className="field">
                <span>Notas</span>
                <input
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </label>
              <button type="submit" className="btn btn-block">
                Liberar acesso
              </button>
            </form>
          </section>

          <section className="admin-card">
            <h2>Liberados ({whitelist.length})</h2>
            {!whitelist.length ? (
              <p className="hint">Nenhum ainda.</p>
            ) : (
              <ul className="phone-list">
                {whitelist.map((e) => (
                  <li key={e.id}>
                    <div>
                      <strong>{e.phone_e164}</strong>
                      <span>{e.label || "—"}</span>
                      {e.notes ? <small>{e.notes}</small> : null}
                    </div>
                    <button
                      type="button"
                      className="btn ghost"
                      onClick={async () => {
                        const r = await fetch(
                          `/api/admin/whitelist?id=${encodeURIComponent(e.id)}&list=whitelist`,
                          {
                            method: "DELETE",
                            headers: { Authorization: `Bearer ${token}` },
                          }
                        );
                        if (!r.ok) setError("Falha ao remover");
                        else {
                          setMsg("Removido da whitelist.");
                          await load();
                        }
                      }}
                    >
                      Remover
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}

      {tab === "banir" ? (
        <>
          <section className="admin-card">
            <h2>Banir número</h2>
            <p className="hint">
              Número banido não recebe resposta do Assessor. Regras automáticas
              de banimento vêm depois — por enquanto é manual.
            </p>
            <form
              className="stack"
              onSubmit={async (e) => {
                e.preventDefault();
                setMsg("");
                const ok = await post({
                  action: "blacklist_add",
                  phone: banPhone,
                  reason: banReason || undefined,
                });
                if (ok) {
                  setBanPhone("");
                  setBanReason("");
                  setMsg("Número banido.");
                  await load();
                }
              }}
            >
              <label className="field">
                <span>WhatsApp</span>
                <input
                  value={banPhone}
                  onChange={(e) => setBanPhone(e.target.value)}
                  placeholder="+5511…"
                  required
                  inputMode="tel"
                />
              </label>
              <label className="field">
                <span>Motivo</span>
                <input
                  value={banReason}
                  onChange={(e) => setBanReason(e.target.value)}
                  placeholder="abuso, spam…"
                />
              </label>
              <button type="submit" className="btn btn-block btn-danger">
                Banir
              </button>
            </form>
          </section>

          <section className="admin-card">
            <h2>Banidos ({blacklist.length})</h2>
            {!blacklist.length ? (
              <p className="hint">Nenhum banido.</p>
            ) : (
              <ul className="phone-list">
                {blacklist.map((e) => (
                  <li key={e.id}>
                    <div>
                      <strong>{e.phone_e164}</strong>
                      <span>{e.reason || "—"}</span>
                    </div>
                    <button
                      type="button"
                      className="btn ghost"
                      onClick={async () => {
                        const r = await fetch(
                          `/api/admin/whitelist?id=${encodeURIComponent(e.id)}&list=blacklist`,
                          {
                            method: "DELETE",
                            headers: { Authorization: `Bearer ${token}` },
                          }
                        );
                        if (!r.ok) setError("Falha ao desbanir");
                        else {
                          setMsg("Desbanido.");
                          await load();
                        }
                      }}
                    >
                      Desbanir
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}
    </main>
  );
}
