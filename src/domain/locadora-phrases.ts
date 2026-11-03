/**
 * Frases da locadora, sem importar mais nada.
 * Fica isolado para um ciclo de módulo não transformar a função em undefined.
 */

function fold(s: string) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/** Frase de ação: o Finance precisa do texto original, não do canônico. */
export function isLocadoraAcaoPhrase(text: string): boolean {
  const q = fold(text);
  if (!q.trim()) return false;
  if (/agenda de vistoria|agendar vistoria/.test(q)) return true;
  if (/^vistoria\s+\d{1,2}\b/.test(q)) return true;
  if (
    /nao fizeram vistoria|sem vistoria|fizeram vistoria/.test(q) ||
    /quais .{0,50}vistoria/.test(q) ||
    /veiculos?.{0,40}vistoria/.test(q) ||
    /vistoria .{0,20}(essa|esta) semana/.test(q)
  ) {
    return true;
  }
  return false;
}

/** Foto ou frase que grava na locadora. Foto sem essa frase, ou nota pessoal, continua pessoal. */
export function isLocadoraInclusaoPhrase(text: string): boolean {
  const q = fold(text);
  if (!q.trim()) return false;
  if (/\bnota pessoal\b/.test(q)) return false;
  return /incluir (essa |esta |a )?multa|cadastrar (essa |esta |a )?multa|incluir motorista|incluir locatario|nota da locadora|nota da empresa|nota da placa|manutencao da placa/.test(
    q
  );
}
