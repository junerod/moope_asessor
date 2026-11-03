export type VisionDocKind = "receita_medica" | "nota_recibo" | "documento";

export type PhotoScene = "financeiro" | "comida" | "outro";

export type FoodPer100g = {
  name: string;
  kcal?: number | null;
  protein_g?: number | null;
  fat_g?: number | null;
  carbs_g?: number | null;
};

export type ExtractedVisionFields = {
  kind: VisionDocKind;
  summary: string;
  doctor?: string | null;
  crm?: string | null;
  medicine?: string | null;
  dosage?: string | null;
  patient?: string | null;
  merchant?: string | null;
  amount?: number | null;
  currency?: string | null;
  date?: string | null;
  category?: string | null;
  rawText?: string | null;
  scene?: PhotoScene | null;
  subject?: string | null;
  foods?: FoodPer100g[] | null;
};

const RECEITA_HINT =
  /\b(receita|rem[eé]dio|medicamento|crm|sublingual|comprimido|frasco|notifica[cç][aã]o de receita)\b/i;
const NOTA_HINT =
  /\b(nota|recibo|cupom|nf-?e|gasolina|posto|mercado|correio|sedex|pix|r\$|total|valor|boleto|vencimento|cedente)\b/i;

export function detectVisionDocKind(
  caption?: string | null,
  filename?: string | null
): VisionDocKind {
  const blob = `${caption || ""} ${filename || ""}`;
  if (RECEITA_HINT.test(blob)) return "receita_medica";
  if (NOTA_HINT.test(blob)) return "nota_recibo";
  return "documento";
}

export function visionPromptLocadora(): string {
  return [
    "A foto é um documento de locadora: multa de trânsito, CNH ou nota fiscal.",
    "A foto pode estar rotacionada. Extraia só o que estiver legível. Não invente.",
    "Responda SOMENTE JSON válido, sem markdown:",
    JSON.stringify({
      kind: "documento",
      amount: null,
      date: null,
      merchant: null,
      rawText:
        "linhas placa: valor: data: ait: nome: cpf: cnh: validade: fornecedor: telefone:",
      summary: "1 frase",
    }),
  ].join("\n");
}

export function visionPromptForKind(kind: VisionDocKind): string {
  const rotation =
    "A foto pode estar rotacionada ou torta — leia mesmo assim, priorizando texto IMPRESSO do cabeçalho.";
  if (kind === "receita_medica") {
    return [
      "Você está lendo uma receita médica brasileira (foto).",
      rotation,
      "Extraia APENAS o que estiver legível. Não invente.",
      "Médico/CRM costumam estar impressos no cabeçalho (Identificação do Emitente).",
      "Remédio/dosagem costumam estar manuscritos no meio.",
      "Responda SOMENTE JSON válido, sem markdown:",
      JSON.stringify({
        kind: "receita_medica",
        doctor: "nome do médico ou null",
        crm: "CRM ou null",
        patient: "paciente ou null",
        medicine: "nome do remédio ou null",
        dosage: "dosagem/posologia ou null",
        date: "data ou null",
        rawText: "texto útil extraído",
        summary: "1 frase em português do que é o documento",
      }),
    ].join("\n");
  }
  if (kind === "nota_recibo") {
    return [
      "Você está lendo nota fiscal, cupom, recibo, comprovante OU boleto bancário.",
      rotation,
      "Extraia APENAS o que estiver legível. Não invente.",
      "Se for boleto: merchant = cedente/beneficiário; date = vencimento; category = conta.",
      "category deve ser uma de: gasolina, mercado, correio, farmacia, restaurante, transporte, servico, conta, outro.",
      "amount em número decimal (ex: 189.90). currency tipicamente BRL.",
      "Responda SOMENTE JSON válido, sem markdown:",
      JSON.stringify({
        kind: "nota_recibo",
        merchant: "estabelecimento ou null",
        amount: 0,
        currency: "BRL",
        date: "data ou vencimento ou null",
        category: "gasolina",
        rawText: "texto útil extraído",
        summary: "1 frase em português",
      }),
    ].join("\n");
  }
  return [
    "Extraia texto e dados relevantes desta imagem (documento, comprovante, receita, nota).",
    rotation,
    "Não invente campos ausentes.",
    "Responda SOMENTE JSON válido, sem markdown:",
    JSON.stringify({
      kind: "documento",
      rawText: "texto útil",
      summary: "1 frase em português",
      merchant: null,
      amount: null,
      doctor: null,
      medicine: null,
      date: null,
      category: null,
    }),
  ].join("\n");
}

export function visionScenePrompt(): string {
  return [
    "Classifique a foto em UM destes cenários:",
    "- financeiro: nota fiscal, cupom, recibo, boleto, orçamento ou proposta com valor",
    "- comida: prato, alimento ou embalagem de comida",
    "- outro: qualquer outra coisa",
    "Não invente valor, nome ou data que não esteja visível.",
    "subject: de 3 a 8 palavras do que aparece, em português.",
    "Se for comida, liste cada alimento visível com estimativa por 100 g: kcal, protein_g, fat_g, carbs_g.",
    "Se for financeiro, category uma de: gasolina, mercado, farmacia, restaurante, transporte, servico, conta, material, obra, orcamento, outro.",
    "amount em número decimal só se o valor estiver escrito. currency BRL.",
    "Responda SOMENTE JSON válido, sem markdown:",
    JSON.stringify({
      scene: "outro",
      subject: "o que aparece",
      summary: "1 frase",
      merchant: null,
      amount: null,
      currency: "BRL",
      date: null,
      category: null,
      foods: [
        {
          name: "alimento",
          kcal: 0,
          protein_g: 0,
          fat_g: 0,
          carbs_g: 0,
        },
      ],
    }),
  ].join("\n");
}

export function replyForUnaskedPhoto(
  extracted: ExtractedVisionFields | null | undefined
): string | null {
  if (!extracted) return null;
  const scene = extracted.scene;
  if (
    extracted.amount != null &&
    extracted.amount > 0 &&
    (scene === "financeiro" || extracted.kind === "nota_recibo")
  ) {
    return null;
  }
  if (scene === "financeiro") {
    const who = extracted.merchant ? ` de *${extracted.merchant}*` : "";
    const cat = extracted.category ? `\nCategoria que eu usaria: *${extracted.category}*.` : "";
    return `📄 Isso parece um documento financeiro${who}.${cat}\n\nNão vi um valor legível, então não lancei nada.\nManda o valor que eu registro. Ex.: *anota 189,90*.`;
  }
  if (scene === "comida") {
    const foods = (extracted.foods || []).filter((f) => f.name).slice(0, 6);
    const lines = foods.map((f) => {
      const bits = [
        f.kcal != null ? `${Math.round(f.kcal)} kcal` : null,
        f.protein_g != null ? `proteína ${fmtG(f.protein_g)}` : null,
        f.fat_g != null ? `gordura ${fmtG(f.fat_g)}` : null,
        f.carbs_g != null ? `carboidrato ${fmtG(f.carbs_g)}` : null,
      ].filter(Boolean);
      return `• *${f.name}* — ${bits.join(" · ") || "sem números claros"}`;
    });
    const subject = extracted.subject || "comida";
    const media = plateAverage(foods);
    return [
      `🍽️ Foto de *${subject}*`,
      "",
      "Por *100 g* (estimativa a partir da foto, não é análise de laboratório):",
      lines.length ? lines.join("\n") : "Não consegui separar os alimentos. Manda mais de perto.",
      media ? `\n📊 *Média do prato* (por 100 g): ${media}` : "",
      "",
      "_Se quiser, diga o peso do prato que eu calculo a porção._",
    ]
      .filter((line) => line !== "")
      .join("\n");
  }
  const subject = extracted.subject || extracted.summary || "uma imagem";
  return [
    `📷 Você mandou uma foto de *${subject}*.`,
    "",
    "Quer que eu *mande para alguém* ou *só guarde*?",
    "Se for só guardar, não precisa responder — a foto já ficou salva e eu não faço mais nada.",
    "Se for para alguém, diga o nome ou *para o grupo NOME*.",
  ].join("\n");
}

function plateAverage(foods: FoodPer100g[]): string | null {
  const mean = (pick: (f: FoodPer100g) => number | null | undefined) => {
    const nums = foods
      .map(pick)
      .filter((n): n is number => n != null && Number.isFinite(n));
    if (!nums.length) return null;
    return nums.reduce((a, b) => a + b, 0) / nums.length;
  };
  const kcal = mean((f) => f.kcal);
  const protein = mean((f) => f.protein_g);
  const fat = mean((f) => f.fat_g);
  const carbs = mean((f) => f.carbs_g);
  const bits = [
    kcal != null ? `${Math.round(kcal)} kcal` : null,
    protein != null ? `proteína ${fmtG(protein)}` : null,
    fat != null ? `gordura ${fmtG(fat)}` : null,
    carbs != null ? `carboidrato ${fmtG(carbs)}` : null,
  ].filter(Boolean);
  return bits.length ? bits.join(" · ") : null;
}

function fmtG(n: number) {
  const v = Math.round(n * 10) / 10;
  return `${String(v).replace(".", ",")} g`;
}

function asFoods(v: unknown): FoodPer100g[] | null {
  if (!Array.isArray(v)) return null;
  const out: FoodPer100g[] = [];
  for (const item of v.slice(0, 8)) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const name = asStr(row.name);
    if (!name) continue;
    out.push({
      name,
      kcal: asNumber(row.kcal),
      protein_g: asNumber(row.protein_g),
      fat_g: asNumber(row.fat_g),
      carbs_g: asNumber(row.carbs_g),
    });
  }
  return out.length ? out : null;
}

function asScene(v: unknown): PhotoScene | null {
  const s = asStr(v);
  if (s === "financeiro" || s === "comida" || s === "outro") return s;
  return null;
}

function stripFence(text: string): string {
  const t = text.trim();
  const m = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (m?.[1] || t).trim();
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(
      v
        .replace(/[^\d,.-]/g, "")
        .replace(/\.(?=.*\.)/g, "")
        .replace(",", ".")
    );
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asStr(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || /^(null|undefined|n\/a|none)$/i.test(s)) return null;
  return s;
}

export function parseVisionExtraction(
  text: string,
  fallbackKind: VisionDocKind
): ExtractedVisionFields {
  const cleaned = stripFence(text || "");
  try {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const obj = JSON.parse(cleaned.slice(start, end + 1)) as Record<
        string,
        unknown
      >;
      const scene = asScene(obj.scene);
      const kindRaw = asStr(obj.kind) as VisionDocKind | null;
      const kind =
        kindRaw === "receita_medica" || kindRaw === "nota_recibo" || kindRaw === "documento"
          ? kindRaw
          : scene === "financeiro"
            ? "nota_recibo"
            : fallbackKind;
      const amount = asNumber(obj.amount);
      const summary =
        asStr(obj.summary) ||
        asStr(obj.rawText)?.slice(0, 180) ||
        "Documento analisado pela imagem.";
      return {
        kind,
        summary,
        doctor: asStr(obj.doctor),
        crm: asStr(obj.crm),
        medicine: asStr(obj.medicine),
        dosage: asStr(obj.dosage),
        patient: asStr(obj.patient),
        merchant: asStr(obj.merchant),
        amount,
        currency: asStr(obj.currency) || (amount != null ? "BRL" : null),
        date: asStr(obj.date),
        category: asStr(obj.category)?.toLowerCase() || null,
        rawText: asStr(obj.rawText) || cleaned,
        scene,
        subject: asStr(obj.subject),
        foods: asFoods(obj.foods),
      };
    }
  } catch {
    // fall through — free text
  }
  return {
    kind: fallbackKind,
    summary: cleaned.slice(0, 180) || "Conteúdo da imagem lido.",
    rawText: cleaned,
  };
}

export function formatVisionForAgent(extracted: ExtractedVisionFields): string {
  const lines: string[] = [`Tipo: ${extracted.kind}`, extracted.summary];
  if (extracted.doctor) lines.push(`Médico: ${extracted.doctor}`);
  if (extracted.crm) lines.push(`CRM: ${extracted.crm}`);
  if (extracted.patient) lines.push(`Paciente: ${extracted.patient}`);
  if (extracted.medicine) lines.push(`Remédio: ${extracted.medicine}`);
  if (extracted.dosage) lines.push(`Dosagem: ${extracted.dosage}`);
  if (extracted.merchant) lines.push(`Estabelecimento: ${extracted.merchant}`);
  if (extracted.amount != null) {
    lines.push(
      `Valor: ${extracted.currency || "BRL"} ${extracted.amount.toFixed(2)}`
    );
  }
  if (extracted.category) lines.push(`Categoria: ${extracted.category}`);
  if (extracted.date) lines.push(`Data: ${extracted.date}`);
  if (extracted.rawText) {
    lines.push("", "Texto extraído:", extracted.rawText.slice(0, 2500));
  }
  return lines.join("\n");
}

export function memoryContentFromExtraction(
  extracted: ExtractedVisionFields,
  caption?: string | null
): string {
  if (extracted.kind === "receita_medica") {
    const bits = [
      caption?.trim() || "Receita médica",
      extracted.medicine && `remédio ${extracted.medicine}`,
      extracted.dosage && extracted.dosage,
      extracted.doctor && `médico ${extracted.doctor}`,
      extracted.crm && `CRM ${extracted.crm}`,
    ].filter(Boolean);
    return bits.join(" — ");
  }
  if (extracted.kind === "nota_recibo" && extracted.amount != null) {
    const cat = extracted.category || "despesa";
    const who = extracted.merchant || "estabelecimento";
    return `Despesa ${cat}: R$ ${extracted.amount.toFixed(2)} em ${who}${
      extracted.date ? ` (${extracted.date})` : ""
    }`;
  }
  return (
    (caption?.trim() ? `${caption.trim()}: ` : "") +
    (extracted.summary || extracted.rawText?.slice(0, 200) || "Documento da imagem")
  );
}

export const CATEGORY_EMOJI: Record<string, string> = {
  gasolina: "⛽",
  mercado: "🛒",
  correio: "📦",
  farmacia: "💊",
  restaurante: "🍽️",
  transporte: "🚗",
  servico: "🧾",
  outro: "💸",
};
