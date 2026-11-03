"use client";

import { useEffect, useState } from "react";
import { AdminNav } from "@/components/admin/AdminNav";
import "../admin.css";

export default function AdminJobsPage() {
  const [token, setToken] = useState("");
  const [status, setStatus] = useState("dead");
  const [jobs, setJobs] = useState<
    Array<{
      id: string;
      status: string;
      last_error: string | null;
      job_type: string;
    }>
  >([]);
  const [msg, setMsg] = useState("");

  async function load(tok: string, st: string) {
    const q = st ? `?status=${st}` : "";
    const res = await fetch(`/api/admin/jobs${q}`, {
      headers: { Authorization: `Bearer ${tok}` },
    });
    const data = await res.json();
    setJobs(data.jobs || []);
  }

  useEffect(() => {
    const t = localStorage.getItem("assessor_admin_token") || "";
    setToken(t);
    if (t) void load(t, status);
  }, [status]);

  async function reprocess(jobId: string) {
    const res = await fetch("/api/admin/jobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ job_id: jobId }),
    });
    const data = await res.json();
    setMsg(res.ok ? `Reprocessado → ${data.new_job_id}` : data.error);
    await load(token, status);
  }

  return (
    <div className="admin-shell admin-shell-nav">
      <header className="admin-top">
        <div>
          <h1 className="admin-brand">Jobs</h1>
          <p className="admin-sub">Dead letter e reprocessamento auditável</p>
        </div>
        <AdminNav current="jobs" />
      </header>
      {msg && <p className="toast">{msg}</p>}
      <section className="admin-card">
        <div className="field">
          <label>Filtro</label>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">todos</option>
            <option value="pending">pending</option>
            <option value="processing">processing</option>
            <option value="failed">failed</option>
            <option value="dead">dead</option>
            <option value="completed">completed</option>
            <option value="retry">retry</option>
          </select>
        </div>
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {jobs.map((j) => (
            <li
              key={j.id}
              style={{
                marginBottom: "0.85rem",
                paddingBottom: "0.85rem",
                borderBottom: "1px solid var(--line)",
              }}
            >
              <strong>{j.job_type}</strong> — {j.status}
              <div className="admin-sub">{j.last_error}</div>
              {(j.status === "dead" || j.status === "failed") && (
                <button
                  className="btn secondary"
                  style={{ marginTop: 8 }}
                  type="button"
                  onClick={() => void reprocess(j.id)}
                >
                  Reprocessar
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
