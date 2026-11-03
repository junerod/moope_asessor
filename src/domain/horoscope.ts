import { DateTime } from "luxon";

export type SignId =
  | "aries"
  | "touro"
  | "gemeos"
  | "cancer"
  | "leao"
  | "virgem"
  | "libra"
  | "escorpiao"
  | "sagitario"
  | "capricornio"
  | "aquario"
  | "peixes";

const SIGNS: Array<{ id: SignId; label: string; names: string[] }> = [
  { id: "aries", label: "Áries", names: ["aries", "áries"] },
  { id: "touro", label: "Touro", names: ["touro"] },
  { id: "gemeos", label: "Gêmeos", names: ["gemeos", "gêmeos", "gemios"] },
  { id: "cancer", label: "Câncer", names: ["cancer", "câncer"] },
  { id: "leao", label: "Leão", names: ["leao", "leão"] },
  { id: "virgem", label: "Virgem", names: ["virgem"] },
  { id: "libra", label: "Libra", names: ["libra"] },
  { id: "escorpiao", label: "Escorpião", names: ["escorpiao", "escorpião"] },
  { id: "sagitario", label: "Sagitário", names: ["sagitario", "sagitário"] },
  {
    id: "capricornio",
    label: "Capricórnio",
    names: ["capricornio", "capricórnio"],
  },
  { id: "aquario", label: "Aquário", names: ["aquario", "aquário"] },
  { id: "peixes", label: "Peixes", names: ["peixes"] },
];

const LINES = [
  "Hoje combina um passo curto e feito, não um plano gigante.",
  "Tem conversa que rende mais se você esperar uma hora.",
  "O dia pede uma coisa boa e simples, do tipo que cabe na pausa do café.",
  "Se algo travou ontem, hoje é dia de tentar por outro lado.",
  "Guarde energia para o que você mesmo marcou. O resto pode esperar.",
  "Uma mensagem curta resolve mais do que um texto longo.",
  "O humor melhora quando você termina uma coisa pequena.",
  "Não precisa decidir a semana. Decide a próxima hora.",
];

export function listSignLabels(): string {
  return SIGNS.map((s) => s.label).join(", ");
}

export function signLabel(id: SignId): string {
  return SIGNS.find((s) => s.id === id)?.label || id;
}

export function parseSign(text: string): SignId | null {
  const t = norm(text);
  const hit = SIGNS.find((s) =>
    s.names.some((n) => t === norm(n) || new RegExp(`\\b${norm(n)}\\b`).test(t))
  );
  return hit?.id || null;
}

export function isSignId(value: string): value is SignId {
  return SIGNS.some((s) => s.id === value);
}

/** Texto estável no dia. Brincadeira, sem conselho. */
export function horoscopeLine(sign: SignId, now = DateTime.now().setZone("America/Sao_Paulo")): string {
  const day = now.ordinal;
  const idx = (day + SIGNS.findIndex((s) => s.id === sign)) % LINES.length;
  return LINES[idx] || LINES[0];
}

export function signChoiceBlock(lead: string): string {
  return [
    lead,
    `${listSignLabels()}.`,
    "",
    "_É brincadeira. Como tudo na vida, não leve ao pé da letra._",
  ].join("\n");
}

export function formatHoroscope(sign: SignId, now = DateTime.now().setZone("America/Sao_Paulo")): string {
  const dia = now.setLocale("pt-BR").toFormat("d 'de' MMMM");
  return [
    `✨ *${signLabel(sign)}* · ${dia}`,
    horoscopeLine(sign, now),
    "_Para parar o aviso do dia: “desliga horóscopo”._",
  ].join("\n");
}

function norm(text: string): string {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
