"use client";

export function MiniMap({
  mode,
  from,
  to,
  minutes,
  label,
  place,
}: {
  mode: "route" | "pin";
  from?: string;
  to?: string;
  minutes?: string;
  label?: string;
  place?: string;
}) {
  const caption =
    mode === "route"
      ? `${from} → ${to} · ${minutes}`
      : `${label} · ${place}`;

  return (
    <figure className="pd-map">
      <svg viewBox="0 0 320 150" role="img" aria-label={caption}>
        <rect width="320" height="150" rx="12" fill="#e7f6ee" />
        <path d="M0 28 C70 18 90 70 150 48 C210 26 230 8 320 22 L320 0 L0 0 Z" fill="#b3e5fc" />
        <ellipse cx="250" cy="118" rx="52" ry="22" fill="#c8e6c9" />
        <path
          d="M18 118 C70 112 88 78 140 86 C190 94 210 54 302 62"
          fill="none"
          stroke="#ffffff"
          strokeWidth="14"
          strokeLinecap="round"
        />
        <path
          d="M18 118 C70 112 88 78 140 86 C190 94 210 54 302 62"
          fill="none"
          stroke="#90a4ae"
          strokeWidth="2"
          strokeDasharray="7 7"
        />
        {mode === "route" ? (
          <>
            <circle cx="36" cy="112" r="9" fill="#2e7d32" stroke="#fff" strokeWidth="3" />
            <circle cx="286" cy="64" r="9" fill="#c62828" stroke="#fff" strokeWidth="3" />
          </>
        ) : (
          <>
            <path d="M168 38c-14 0-24 10-24 24 0 18 24 40 24 40s24-22 24-40c0-14-10-24-24-24z" fill="#1565c0" />
            <circle cx="168" cy="60" r="8" fill="#fff" />
          </>
        )}
      </svg>
      <figcaption>{caption}</figcaption>
    </figure>
  );
}
