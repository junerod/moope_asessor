"use client";

import { useEffect, useState } from "react";
import { AdminNav } from "@/components/admin/AdminNav";
import "../admin.css";

type Audience = {
  id: string;
  label: string;
  description: string;
};

type PreviewRow = {
  phone: string | null;
  name: string | null;
  segment: string | null;
};

export default function AdminBroadcastPage() {
  const [token, setToken] = useState("");
  const [audiences, setAudiences] = useState<Audience[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [audience, setAudience] = useState("all");
  const [message, setMessage] = useState("");
  const [confirm, setConfirm] = useState("");
  const [preview, setPreview] = useState<PreviewRow[]>([]);
  const [count, setCount] = useState(0);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imageUrl, setImageUrl] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [testedDev, setTestedDev] = useState(false);

  useEffect(() => {
    setToken(localStorage.getItem("assessor_admin_token") || "");
  }, []);

  useEffect(() => {
    if (!imageFile) {
      setPreviewUrl(null);
      return;
    }
    const u = URL.createObjectURL(imageFile);
    setPreviewUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [imageFile]);

  async function loadBase(t = token) {
    if (!t) return;
    setLoading(true);
    setError("");
    try {
      const r = await fetch("/api/admin/broadcast", {
        headers: { Authorization: `Bearer ${t}` },
      });
      const d = await r.json();
      if (!r.ok) {
        setError(
          d.error === "super_admin_required"
            ? "Só super_admin pode enviar broadcast."
            : d.error || "Sem acesso — faça login no Admin."
        );
        return;
      }
      setAudiences(d.audiences || []);
      setCounts(d.counts || {});
    } finally {
      setLoading(false);
    }
  }

  async function loadAudience(id: string, t = token) {
    if (!t) return;
    setAudience(id);
    setLoading(true);
    setError("");
    try {
      const r = await fetch(`/api/admin/broadcast?audience=${id}`, {
        headers: { Authorization: `Bearer ${t}` },
      });
      const d = await r.json();
      if (!r.ok) {
        setError(d.error || "Falha ao carregar audiência");
        return;
      }
      setCounts(d.counts || {});
      setCount(Number(d.count || 0));
      setPreview(d.preview || []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (token) {
      void loadBase(token).then(() => loadAudience("all", token));
    }
  }, [token]);

  useEffect(() => {
    setTestedDev(false);
  }, [audience, message, imageFile, imageUrl]);

  async function post(opts: {
    dryRun?: boolean;
    testDev?: boolean;
  }) {
    setSending(true);
    setError("");
    setMsg("");
    try {
      const form = new FormData();
      form.set("audience", audience);
      form.set("message", message);
      form.set("dry_run", opts.dryRun ? "true" : "false");
      form.set("test_dev", opts.testDev ? "true" : "false");
      if (!opts.dryRun && !opts.testDev) form.set("confirm", confirm);
      if (imageUrl.trim()) form.set("image_url", imageUrl.trim());
      if (imageFile) form.set("image", imageFile);

      const r = await fetch("/api/admin/broadcast", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      const d = await r.json();
      if (!r.ok) {
        setError(d.error || "Falha no envio");
        return;
      }
      const res = d.result || {};
      if (opts.testDev) {
        setTestedDev(true);
        setMsg(
          `Teste DEV: ${res.sent ? "enviado ✅" : "falhou"} · confira o Zap +5561996715985`
        );
      } else if (opts.dryRun) {
        setMsg(`Simulação: ${res.total} destinatário(s).`);
      } else {
        setMsg(`Enviado: ${res.sent}/${res.total} · falhas: ${res.failed}`);
        setConfirm("");
      }
    } finally {
      setSending(false);
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

  const canMass =
    testedDev &&
    confirm === "ENVIAR" &&
    count >= 1 &&
    (message.trim().length >= 3 || imageFile || imageUrl.trim());

  return (
    <main className="admin-shell admin-shell-nav">
      <header className="admin-top">
        <div>
          <p className="eyebrow">MOOPE Assessor</p>
          <h1 className="admin-brand">Post / Broadcast</h1>
          <p className="admin-sub">
            Texto ou imagem+legenda · teste no DEV antes do envio em massa.
          </p>
        </div>
        <AdminNav current="broadcast" />
      </header>

      {error ? <p className="toast err">{error}</p> : null}
      {msg ? <p className="toast">{msg}</p> : null}

      <section className="admin-card">
        <h2>Para quem</h2>
        <div className="broadcast-grid">
          {audiences.map((a) => {
            const n = counts[a.id] ?? 0;
            const active = audience === a.id;
            return (
              <button
                key={a.id}
                type="button"
                className={`broadcast-chip${active ? " active" : ""}`}
                onClick={() => void loadAudience(a.id)}
                disabled={loading || sending}
              >
                <strong>{a.label}</strong>
                <span className="broadcast-count">{n}</span>
                <small>{a.description}</small>
              </button>
            );
          })}
        </div>
        <p className="muted">
          Selecionado: <strong>{count}</strong>
          {loading ? " · carregando…" : ""}
        </p>
      </section>

      <section className="admin-card">
        <h2>Post</h2>
        <label className="admin-label">
          Imagem (opcional)
          <input
            type="file"
            accept="image/*"
            onChange={(e) => setImageFile(e.target.files?.[0] || null)}
          />
        </label>
        {previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={previewUrl} alt="Prévia" className="broadcast-img-preview" />
        ) : null}
        <label className="admin-label">
          Ou URL https da imagem
          <input
            value={imageUrl}
            onChange={(e) => setImageUrl(e.target.value)}
            placeholder="https://…"
            inputMode="url"
          />
        </label>
        <label className="admin-label">
          Legenda / texto
          <textarea
            rows={5}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Legenda do post ou mensagem…"
            maxLength={3500}
          />
        </label>
        <p className="muted">{message.length}/3500</p>

        <div className="admin-actions admin-actions-stack">
          <button
            type="button"
            className="btn secondary"
            disabled={
              sending ||
              (message.trim().length < 3 && !imageFile && !imageUrl.trim())
            }
            onClick={() => void post({ dryRun: true })}
          >
            Contar destinatários
          </button>
          <button
            type="button"
            className="btn"
            disabled={
              sending ||
              (message.trim().length < 3 && !imageFile && !imageUrl.trim())
            }
            onClick={() => void post({ testDev: true })}
          >
            1. Testar no Zap DEV
          </button>
        </div>

        <label className="admin-label">
          2. Digite <code>ENVIAR</code> (só depois do teste DEV)
          <input
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="ENVIAR"
            autoComplete="off"
          />
        </label>
        {!testedDev ? (
          <p className="muted">Envio em massa liberado após o teste no DEV.</p>
        ) : null}

        <div className="admin-actions">
          <button
            type="button"
            className="btn danger"
            disabled={sending || !canMass}
            onClick={() => void post({})}
          >
            {sending ? "Enviando…" : `Enviar para ${count}`}
          </button>
        </div>
      </section>

      <section className="admin-card">
        <h2>Prévia (até 40)</h2>
        {preview.length === 0 ? (
          <p className="muted">Nenhum destinatário neste filtro.</p>
        ) : (
          <ul className="phone-list">
            {preview.map((p, i) => (
              <li key={`${p.phone}-${i}`}>
                <strong>{p.phone || "—"}</strong>
                {p.name ? ` · ${p.name}` : ""}
                {p.segment ? <span> · {p.segment}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
