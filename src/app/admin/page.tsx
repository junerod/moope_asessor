"use client";

import { useEffect, useMemo, useState } from "react";
import { AdminNav } from "@/components/admin/AdminNav";
import "./admin.css";

type Dash = {
  metrics: Record<string, number>;
  status: Record<string, string>;
  webhook_url: string;
  bootstrap?: {
    zernio_from_env?: boolean;
    openai_from_env?: boolean;
    email_from_env?: boolean;
  };
};

type ZernioNumber = {
  account_id: string;
  profile_id: string;
  phone: string;
  name: string;
  label: string;
};

type ProviderRow = {
  provider_key: string;
  enabled: boolean;
  config?: Record<string, unknown>;
  secrets?: Record<string, string>;
  last_test_status?: string;
  source?: string;
  has_env_fallback?: boolean;
  has_usable_key?: boolean;
};

function statusTone(v: string) {
  const s = String(v || "").toUpperCase();
  if (s.includes("ONLINE") || s.includes("CONNECTED")) return "ok";
  if (s.includes("OFFLINE") || s.includes("NOT_CONFIGURED")) return "warn";
  if (s.includes("ERROR") || s.includes("INVALID")) return "err";
  return "";
}

export default function AdminPage() {
  const [token, setToken] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [dash, setDash] = useState<Dash | null>(null);
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(false);

  const [apiKey, setApiKey] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [numbers, setNumbers] = useState<ZernioNumber[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [listing, setListing] = useState(false);
  const [savingZernio, setSavingZernio] = useState(false);
  const [syncingWebhook, setSyncingWebhook] = useState(false);
  const [webhookInfo, setWebhookInfo] = useState<{
    webhook_url: string;
    public_url: boolean;
    matched: { id: string; name: string; url: string; is_active: boolean } | null;
  } | null>(null);


  const [openaiKey, setOpenaiKey] = useState("");
  const [savingOpenAI, setSavingOpenAI] = useState(false);
  const [emailForm, setEmailForm] = useState({
    base_url: "https://mailserver.moope.com.br",
    api_key: "",
    from_address: "info@info.moope.com.br",
    from_name: "MOOPE Assessor",
    test_to: "",
  });
  const [savingEmail, setSavingEmail] = useState(false);

  const zernioProvider = useMemo(
    () => providers.find((p) => p.provider_key === "zernio"),
    [providers]
  );

  const selectedNumber = numbers.find((n) => n.account_id === selectedId);
  const savedPhone = String(zernioProvider?.config?.official_number || "");
  const savedAccount = String(zernioProvider?.config?.account_id || "");
  const hasSavedKey = Boolean(
    zernioProvider?.secrets?.api_key || zernioProvider?.has_usable_key
  );
  const openaiProvider = useMemo(
    () => providers.find((p) => p.provider_key === "openai_llm"),
    [providers]
  );
  const openaiStatus = String(
    openaiProvider?.last_test_status || dash?.status?.llm || "—"
  );
  const openaiConnected =
    openaiStatus === "connected" ||
    openaiStatus.toUpperCase().includes("CONNECTED");

  const zernioStep = !hasSavedKey && !apiKey
    ? 1
    : numbers.length === 0
      ? 2
      : selectedId
        ? 3
        : 2;

  async function login() {
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "login_failed");
        return;
      }
      const tok = data.access_token as string;
      setToken(tok);
      localStorage.setItem("assessor_admin_token", tok);
      await load(tok);
    } catch {
      setError("Falha de rede ao entrar");
    } finally {
      setLoading(false);
    }
  }

  async function load(tok = token) {
    if (!tok) return;
    const headers = { Authorization: `Bearer ${tok}` };
    const d = await fetch("/api/admin/dashboard", { headers });
    if (d.status === 403 || d.status === 401) {
      setError("Sem permissão de platform_admin");
      setDash(null);
      setToken("");
      localStorage.removeItem("assessor_admin_token");
      return;
    }
    if (!d.ok) {
      setError(`Falha ao carregar dashboard (${d.status})`);
      return;
    }
    setDash(await d.json());
    const p = await fetch("/api/admin/providers", { headers });
    const pj = await p.json();
    const list = (pj.providers || []) as ProviderRow[];
    setProviders(list);
    const z = list.find((x) => x.provider_key === "zernio");
    if (z?.config?.account_id) {
      setSelectedId(String(z.config.account_id));
    }
    const em = list.find((x) => x.provider_key === "email");
    if (em?.config) {
      setEmailForm((prev) => ({
        ...prev,
        base_url: String(em.config?.base_url || prev.base_url),
        from_address: String(em.config?.from_address || prev.from_address),
        from_name: String(em.config?.from_name || prev.from_name),
      }));
    }

    // Bootstrap from .env: auto-list Zernio numbers + probe OpenAI
    const zernioReady = Boolean(z?.has_usable_key);
    const openaiReady = list.some(
      (x) => x.provider_key === "openai_llm" && x.has_usable_key
    );
    if (zernioReady) {
      void autoBuscarNumeros(tok);
      void loadWebhookStatus(tok);
    }
    if (openaiReady) {
      void autoTestOpenAI(tok);
    }
  }

  async function loadWebhookStatus(tok: string) {
    try {
      const res = await fetch("/api/admin/providers/zernio/webhook", {
        headers: { Authorization: `Bearer ${tok}` },
      });
      const data = await res.json();
      if (res.ok) {
        setWebhookInfo({
          webhook_url: data.webhook_url,
          public_url: Boolean(data.public_url),
          matched: data.matched || null,
        });
      }
    } catch {
      /* ignore */
    }
  }

  async function configurarWebhookZernio() {
    setSyncingWebhook(true);
    setError(null);
    setMsg("");
    try {
      const res = await fetch("/api/admin/providers/zernio/webhook", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message || data.error || "Falha ao configurar webhook");
        return;
      }
      setMsg(
        `Webhook Zernio ${data.action === "created" ? "criado" : "atualizado"} · ${data.webhook?.url}`
      );
      await loadWebhookStatus(token);
      await load();
    } catch {
      setError("Falha de rede ao configurar webhook");
    } finally {
      setSyncingWebhook(false);
    }
  }

  async function autoBuscarNumeros(tok: string) {
    setListing(true);
    try {
      const res = await fetch("/api/admin/providers/zernio/numbers", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tok}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message || data.error || "Falha ao listar números (ENV/DB)");
        return;
      }
      const lista = (data.numbers || []) as ZernioNumber[];
      setNumbers(lista);
      if (lista.length === 1) {
        setSelectedId(lista[0].account_id);
      } else if (data.selected_account_id) {
        setSelectedId(String(data.selected_account_id));
      }
      setMsg(
        lista.length
          ? `${lista.length} número(s) Zernio carregados do .env/DB — escolha o MOOPE Assessor.`
          : "Chave Zernio ok, mas sem WhatsApp nas Connections."
      );
    } catch {
      setError("Falha ao buscar números Zernio");
    } finally {
      setListing(false);
    }
  }

  async function autoTestOpenAI(tok: string) {
    try {
      const res = await fetch("/api/admin/providers", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tok}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ provider_key: "openai_llm" }),
      });
      const data = await res.json();
      setProviders((prev) =>
        prev.map((p) =>
          p.provider_key === "openai_llm" ||
          p.provider_key === "openai_embeddings" ||
          p.provider_key === "vision" ||
          p.provider_key === "transcription"
            ? { ...p, last_test_status: data.status || p.last_test_status }
            : p
        )
      );
      // refresh dashboard status strip
      const d = await fetch("/api/admin/dashboard", {
        headers: { Authorization: `Bearer ${tok}` },
      });
      if (d.ok) setDash(await d.json());
    } catch {
      /* ignore auto probe errors */
    }
  }

  useEffect(() => {
    const t = localStorage.getItem("assessor_admin_token") || "";
    if (t) {
      setToken(t);
      void load(t);
    }
  }, []);

  async function buscarNumeros() {
    setListing(true);
    setMsg("");
    setError(null);
    try {
      const res = await fetch("/api/admin/providers/zernio/numbers", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          api_key: apiKey || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message || data.error || "Falha ao listar números");
        setNumbers([]);
        return;
      }
      const lista = (data.numbers || []) as ZernioNumber[];
      setNumbers(lista);
      if (lista.length === 1) {
        setSelectedId(lista[0].account_id);
      } else if (data.selected_account_id) {
        setSelectedId(String(data.selected_account_id));
      }
      if (!lista.length) {
        setMsg(
          "Essa chave não tem WhatsApp em Connections. Conecte um número na Zernio."
        );
      } else {
        setMsg(
          lista.length === 1
            ? `Número encontrado: ${lista[0].label}`
            : `${lista.length} números encontrados — escolha qual a plataforma vai usar.`
        );
      }
    } catch {
      setError("Falha de rede ao buscar números");
    } finally {
      setListing(false);
    }
  }

  async function salvarZernio() {
    if (!selectedId) {
      setError("Escolha o número oficial antes de salvar.");
      return;
    }
    const hit = numbers.find((n) => n.account_id === selectedId);
    setSavingZernio(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/providers/zernio/numbers", {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          api_key: apiKey || undefined,
          webhook_secret: webhookSecret || undefined,
          account_id: selectedId,
          phone: hit?.phone || savedPhone,
          profile_id: hit?.profile_id,
          name: hit?.name,
          enabled: true,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Falha ao salvar Zernio");
        return;
      }
      setApiKey("");
      setWebhookSecret("");
      setMsg("Zernio salva — número oficial configurado.");
      await load();
      const test = await fetch("/api/admin/providers", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ provider_key: "zernio" }),
      });
      const tj = await test.json();
      // Best-effort: register webhook via API Key after selecting the number
      const wh = await fetch("/api/admin/providers/zernio/webhook", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
      const whj = await wh.json().catch(() => ({}));
      if (wh.ok) {
        setMsg(
          `Zernio salva · teste: ${tj.status} · webhook ${whj.action || "ok"}`
        );
        await loadWebhookStatus(token);
      } else {
        setMsg(
          `Zernio salva · teste: ${tj.status}. Webhook: ${whj.message || whj.error || "pendente (URL pública?)"}`
        );
      }
      await load();
    } finally {
      setSavingZernio(false);
    }
  }

  async function saveOpenAI() {
    if (!openaiKey.trim()) {
      setError("Cole a API Key da OpenAI antes de salvar.");
      setMsg("");
      return;
    }
    setSavingOpenAI(true);
    setError(null);
    setMsg("");
    try {
      const headers = {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      };
      const targets = [
        {
          provider_key: "openai_llm",
          config: { model: "gpt-4o-mini" },
        },
        {
          provider_key: "openai_embeddings",
          config: { model: "text-embedding-3-small", dimensions: 1536 },
        },
        { provider_key: "vision", config: {} },
        { provider_key: "transcription", config: {} },
      ] as const;

      for (const t of targets) {
        const res = await fetch("/api/admin/providers", {
          method: "PUT",
          headers,
          body: JSON.stringify({
            provider_key: t.provider_key,
            enabled: true,
            provider_name: "openai",
            config: t.config,
            secrets: { api_key: openaiKey.trim() },
          }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setError(
            `Falha ao salvar ${t.provider_key}: ${data.error || res.status}`
          );
          return;
        }
      }

      const test = await fetch("/api/admin/providers", {
        method: "POST",
        headers,
        body: JSON.stringify({ provider_key: "openai_llm" }),
      });
      const tj = await test.json();
      setOpenaiKey("");
      setMsg(
        `OpenAI salva no banco (criptografada). Teste: ${tj.status || "ok"}`
      );
      await load();
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch {
      setError("Falha de rede ao salvar OpenAI");
    } finally {
      setSavingOpenAI(false);
    }
  }

  async function testOpenAI() {
    setMsg("");
    setError(null);
    const res = await fetch("/api/admin/providers", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ provider_key: "openai_llm" }),
    });
    const data = await res.json();
    setMsg(`OpenAI test: ${data.status}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
    await load();
  }

  async function saveEmail() {
    setSavingEmail(true);
    setError(null);
    setMsg("");
    try {
      const res = await fetch("/api/admin/providers", {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          provider_key: "email",
          enabled: true,
          provider_name: "mailserver",
          config: {
            provider: "mailserver",
            base_url: emailForm.base_url,
            from_name: emailForm.from_name,
            from_address: emailForm.from_address,
          },
          secrets: { api_key: emailForm.api_key || undefined },
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Falha ao salvar email");
        return;
      }
      setEmailForm({ ...emailForm, api_key: "" });
      setMsg("Mailserver salvo no banco (API key criptografada).");
      window.scrollTo({ top: 0, behavior: "smooth" });
      await load();
    } catch {
      setError("Falha de rede ao salvar email");
    } finally {
      setSavingEmail(false);
    }
  }

  async function testEmail() {
    setMsg("");
    setError(null);
    const res = await fetch("/api/admin/providers", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        provider_key: "email",
        to: emailForm.test_to || email,
      }),
    });
    const data = await res.json();
    setMsg(
      `Email test: ${data.status}${data.via ? ` via ${data.via}` : ""}`
    );
    window.scrollTo({ top: 0, behavior: "smooth" });
    await load();
  }

  function logout() {
    localStorage.removeItem("assessor_admin_token");
    setToken("");
    setDash(null);
  }

  if (!token || !dash) {
    return (
      <div className="login-wrap">
        <div className="login-card">
          <h1>MOOPE Assessor</h1>
          <p className="admin-sub">Área interna da plataforma</p>
          {error && <p className="toast err">{error}</p>}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void login();
            }}
            style={{ marginTop: "1.1rem" }}
          >
            <div className="field">
              <label>E-mail</label>
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                placeholder="admin@moope.com.br"
              />
            </div>
            <div className="field">
              <label>Senha</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            </div>
            <button className="btn" type="submit" disabled={loading}>
              {loading ? "Entrando…" : "Entrar"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="admin-shell admin-shell-nav">
      <header className="admin-top">
        <div>
          <h1 className="admin-brand">Admin operacional</h1>
          <p className="admin-sub">Configure providers e acompanhe a saúde do Assessor</p>
        </div>
        <AdminNav current="dashboard" onLogout={logout} />
      </header>

      {msg && (
        <p className="toast" style={{ position: "sticky", top: 8, zIndex: 20 }}>
          {msg}
        </p>
      )}
      {error && (
        <p
          className="toast err"
          style={{ position: "sticky", top: 8, zIndex: 20 }}
        >
          {error}
        </p>
      )}

      <section className="admin-card" style={{ marginBottom: "1rem" }}>
        <h2>Saúde</h2>
        <p className="hint">Status cacheado — testes pagos só quando você clicar em Testar.</p>
        <div className="status-row">
          {Object.entries(dash.status).map(([k, v]) => (
            <div key={k} className={`status-pill ${statusTone(v)}`}>
              <span className="k">{k}</span>
              <span className="v">{v}</span>
            </div>
          ))}
        </div>
        <div className="metric-grid" style={{ marginTop: "0.9rem" }}>
          {Object.entries(dash.metrics || {}).map(([k, v]) => (
            <div key={k} className="metric">
              <b>{String(v)}</b>
              <small>{k.replace(/_/g, " ")}</small>
            </div>
          ))}
        </div>
      </section>

      <div className="admin-grid two">
        <section className="admin-card">
          <h2>WhatsApp / Zernio</h2>
          <p className="hint">
            Usa a <code>ZERNIO_API_KEY</code> do <code>.env</code> (ou a salva no
            banco). Os números carregam automaticamente ao entrar — escolha o
            canal <strong>MOOPE Assessor</strong>.
          </p>

          <div className="steps">
            <span className={`step ${zernioStep >= 1 ? "on" : ""}`}>1. API Key</span>
            <span className={`step ${zernioStep >= 2 ? "on" : ""}`}>2. Números</span>
            <span className={`step ${zernioStep >= 3 ? "on" : ""}`}>3. Escolher</span>
          </div>

          <div className="webhook-box" style={{ marginBottom: "0.9rem" }}>
            <strong>
              Status:{" "}
              {listing ? "Buscando números…" : dash.status.zernio || "—"}
            </strong>
            <div style={{ opacity: 0.75, marginTop: 4 }}>
              Fonte:{" "}
              {zernioProvider?.source === "env" || dash.bootstrap?.zernio_from_env
                ? ".env"
                : zernioProvider
                  ? "banco"
                  : "não configurada"}
              {hasSavedKey ? " · chave disponível" : " · sem chave"}
              {numbers.length ? ` · ${numbers.length} número(s)` : ""}
            </div>
            {(savedPhone || savedAccount) && (
              <>
                <div style={{ marginTop: 8 }}>
                  Oficial: {savedPhone || "—"}
                </div>
                <div style={{ opacity: 0.7 }}>Account: {savedAccount || "—"}</div>
              </>
            )}
          </div>

          <div className="field">
            <label>
              API Key{" "}
              {hasSavedKey
                ? "(•••• do .env/banco — cole outra só se quiser trocar)"
                : ""}
            </label>
            <input
              type="password"
              placeholder={hasSavedKey ? "••••••••••" : "sk_…"}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="off"
            />
          </div>

          <div className="btn-row">
            <button
              className="btn"
              type="button"
              disabled={listing || (!apiKey && !hasSavedKey)}
              onClick={() => void buscarNumeros()}
            >
              {listing ? "Buscando…" : "Buscar números"}
            </button>
          </div>

          {numbers.length === 1 && (
            <div className="webhook-box">
              Número encontrado: <strong>{numbers[0].label}</strong>
            </div>
          )}

          {numbers.length > 1 && (
            <div className="number-list" role="radiogroup" aria-label="Números Zernio">
              {numbers.map((n) => (
                <label
                  key={n.account_id}
                  className={`number-option ${selectedId === n.account_id ? "selected" : ""}`}
                >
                  <input
                    type="radio"
                    name="zernio_numero"
                    checked={selectedId === n.account_id}
                    onChange={() => setSelectedId(n.account_id)}
                  />
                  <div>
                    <strong>{n.label}</strong>
                    {n.name && n.phone && <span>{n.name}</span>}
                    <span>ID …{n.account_id.slice(-6)}</span>
                  </div>
                </label>
              ))}
            </div>
          )}

          {numbers.length === 0 && hasSavedKey && (
            <p className="hint">Clique em Buscar números para carregar da Zernio.</p>
          )}

          <details className="advanced">
            <summary>Avançado (webhook secret)</summary>
            <div className="field" style={{ marginTop: "0.75rem" }}>
              <label>Webhook Secret</label>
              <input
                type="password"
                placeholder="opcional — se a Zernio exigir"
                value={webhookSecret}
                onChange={(e) => setWebhookSecret(e.target.value)}
              />
            </div>
          </details>

          <div className="webhook-box">
            <strong>Webhook URL</strong>
            <div>{webhookInfo?.webhook_url || dash.webhook_url}</div>
            <div style={{ opacity: 0.7, marginTop: 6 }}>
              {webhookInfo?.matched
                ? `Registrado na Zernio · ${webhookInfo.matched.is_active ? "ativo" : "inativo"} · id …${String(webhookInfo.matched.id).slice(-6)}`
                : webhookInfo && !webhookInfo.public_url
                  ? "localhost não recebe webhook da Zernio — use um domínio/túnel público em APP_BASE_URL."
                  : "Ainda não registrado na Zernio. Clique abaixo para criar via API Key."}
            </div>
          </div>

          <div className="btn-row">
            <button
              className="btn"
              type="button"
              disabled={savingZernio || !selectedId}
              onClick={() => void salvarZernio()}
            >
              {savingZernio ? "Salvando…" : "Definir como MOOPE Assessor"}
            </button>
            <button
              className="btn secondary"
              type="button"
              disabled={syncingWebhook || !hasSavedKey}
              onClick={() => void configurarWebhookZernio()}
            >
              {syncingWebhook
                ? "Registrando…"
                : webhookInfo?.matched
                  ? "Atualizar webhook na Zernio"
                  : "Criar webhook na Zernio"}
            </button>
            {selectedNumber && (
              <span className="admin-sub" style={{ alignSelf: "center" }}>
                Selecionado: {selectedNumber.label}
              </span>
            )}
          </div>
        </section>

        <div className="admin-grid">
          <section className="admin-card">
            <h2>Inteligência Artificial</h2>
            <p className="hint">
              Usa <code>OPENAI_API_KEY</code> do <code>.env</code> (ou chave salva
              no banco). Status abaixo é testado automaticamente ao entrar.
            </p>
            <div className="webhook-box" style={{ marginBottom: 12 }}>
              <strong>
                Status:{" "}
                <span className={openaiConnected ? "ok" : ""}>
                  {openaiConnected ? "CONNECTED" : openaiStatus.toUpperCase()}
                </span>
              </strong>
              <div style={{ opacity: 0.75, marginTop: 4 }}>
                Fonte:{" "}
                {openaiProvider?.source === "env" ||
                dash.bootstrap?.openai_from_env
                  ? ".env"
                  : openaiProvider
                    ? "banco"
                    : "não configurada"}
              </div>
            </div>
            <div className="field">
              <label>
                API Key{" "}
                {openaiProvider?.has_usable_key
                  ? "(•••• do .env/banco — cole outra só se quiser trocar)"
                  : ""}
              </label>
              <input
                type="password"
                placeholder={
                  openaiProvider?.has_usable_key ? "••••••••••" : "sk-…"
                }
                value={openaiKey}
                onChange={(e) => setOpenaiKey(e.target.value)}
              />
            </div>
            <div className="btn-row">
              <button
                className="btn"
                type="button"
                disabled={savingOpenAI}
                onClick={() => void saveOpenAI()}
              >
                {savingOpenAI ? "Salvando…" : "Salvar"}
              </button>
              <button
                className="btn secondary"
                type="button"
                onClick={() => void testOpenAI()}
              >
                Testar
              </button>
            </div>
          </section>

          <section className="admin-card">
            <h2>E-mail (mailserver MOOPE)</h2>
            <p className="hint">
              Mesmo mailserver do Finance:{" "}
              <code>https://mailserver.moope.com.br</code> com{" "}
              <code>x-api-key</code>.
            </p>
            {providers.some(
              (p) => p.provider_key === "email" && p.secrets?.api_key
            ) && (
              <div className="webhook-box" style={{ marginBottom: 12 }}>
                Mailserver já configurado · status:{" "}
                {providers.find((p) => p.provider_key === "email")
                  ?.last_test_status || "never"}
              </div>
            )}
            <div className="field">
              <label>URL</label>
              <input
                value={emailForm.base_url}
                onChange={(e) =>
                  setEmailForm({ ...emailForm, base_url: e.target.value })
                }
              />
            </div>
            <div className="field">
              <label>API Key (x-api-key)</label>
              <input
                type="password"
                placeholder="•••• se já salva"
                value={emailForm.api_key}
                onChange={(e) =>
                  setEmailForm({ ...emailForm, api_key: e.target.value })
                }
              />
            </div>
            <div className="field">
              <label>From</label>
              <input
                value={emailForm.from_address}
                onChange={(e) =>
                  setEmailForm({ ...emailForm, from_address: e.target.value })
                }
              />
            </div>
            <div className="field">
              <label>From name</label>
              <input
                value={emailForm.from_name}
                onChange={(e) =>
                  setEmailForm({ ...emailForm, from_name: e.target.value })
                }
              />
            </div>
            <div className="field">
              <label>Destinatário do teste</label>
              <input
                value={emailForm.test_to}
                onChange={(e) =>
                  setEmailForm({ ...emailForm, test_to: e.target.value })
                }
                placeholder="seu@email.com"
              />
            </div>
            <div className="btn-row">
              <button
                className="btn"
                type="button"
                disabled={savingEmail}
                onClick={() => void saveEmail()}
              >
                {savingEmail ? "Salvando…" : "Salvar"}
              </button>
              <button
                className="btn secondary"
                type="button"
                onClick={() => void testEmail()}
              >
                Testar envio
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
