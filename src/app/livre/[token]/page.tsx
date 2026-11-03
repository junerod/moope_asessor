import type { Metadata } from "next";
import { getDb } from "@/db/client";
import { findLivreShare } from "@/domain/public-slots";

export const metadata: Metadata = {
  title: "Horários livres · MOOPE Assessor",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function LivrePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const share = await findLivreShare(getDb(), token);
  if (!share) {
    return (
      <main style={{ fontFamily: "sans-serif", padding: 24 }}>
        <p>Este link expirou.</p>
      </main>
    );
  }
  return (
    <main style={{ fontFamily: "sans-serif", padding: 24, maxWidth: 420 }}>
      <h1 style={{ fontSize: 20 }}>Horários livres</h1>
      <p>Escolha um horário. Você não vê a agenda da pessoa.</p>
      <form action={`/api/livre/${token}`} method="post">
        <label>
          Seu nome
          <input name="guestName" required maxLength={40} style={{ display: "block", width: "100%", margin: "8px 0 16px" }} />
        </label>
        {share.slots.map((slot) => (
          <label key={slot.iso} style={{ display: "block", marginBottom: 8 }}>
            <input type="radio" name="iso" value={slot.iso} required /> {slot.label}
          </label>
        ))}
        <button type="submit" style={{ marginTop: 16 }}>Marcar</button>
      </form>
    </main>
  );
}
