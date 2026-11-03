import type { ReactNode } from "react";

/**
 * Texto da ajuda HTML:
 * - links [rótulo](https://…)
 * - negrito *assim* → <strong> (nunca deixar * literal na página)
 */
export function RichText({ text }: { text: string }) {
  return <>{renderInline(text)}</>;
}

function renderInline(text: string): ReactNode[] {
  const withLinks = splitLinks(text);
  const out: ReactNode[] = [];
  let i = 0;
  for (const part of withLinks) {
    if (typeof part !== "string") {
      out.push(part);
      continue;
    }
    out.push(...splitBold(part, () => `b-${i++}`));
  }
  return out;
}

function splitLinks(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const re = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(
      <a
        key={`l-${i++}`}
        href={m[2]}
        target="_blank"
        rel="noreferrer"
        className="rich-link"
      >
        {m[1]}
      </a>
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function splitBold(text: string, key: () => string): ReactNode[] {
  const parts: ReactNode[] = [];
  // *trecho* sem quebrar no meio de palavras tipo *baixa 1*
  const re = /\*([^*\n]+)\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(<strong key={key()}>{m[1]}</strong>);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length ? parts : [text];
}
